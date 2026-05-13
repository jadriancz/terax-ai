use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc;
use std::thread;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

const DEFAULT_TIMEOUT_SECS: u64 = 60;
const MAX_TIMEOUT_SECS: u64 = 300;
const POLL_INTERVAL: Duration = Duration::from_millis(50);

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpToolCall {
    pub command: String,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub env_vars: HashMap<String, String>,
    pub tool_name: String,
    #[serde(default)]
    pub arguments: Value,
    pub cwd: Option<String>,
    pub timeout_secs: Option<u64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpListTools {
    pub command: String,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub env_vars: HashMap<String, String>,
    pub cwd: Option<String>,
    pub timeout_secs: Option<u64>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpToolInfo {
    pub name: String,
    pub description: Option<String>,
    pub input_schema: Option<Value>,
}

#[tauri::command]
pub async fn mcp_stdio_list_tools(input: McpListTools) -> Result<Vec<McpToolInfo>, String> {
    let timeout = timeout(input.timeout_secs);
    let result = run_stdio_session(
        input.command,
        input.args,
        input.env_vars,
        input.cwd,
        timeout,
        |session| {
            let result = session.request("tools/list", json!({}))?;
            let tools = result
                .get("tools")
                .and_then(Value::as_array)
                .ok_or_else(|| "MCP tools/list response did not include a tools array".to_string())?;

            serde_json::to_value(
                tools
                    .iter()
                    .map(|tool| McpToolInfo {
                        name: tool
                            .get("name")
                            .and_then(Value::as_str)
                            .unwrap_or_default()
                            .to_string(),
                        description: tool
                            .get("description")
                            .and_then(Value::as_str)
                            .map(str::to_string),
                        input_schema: tool.get("inputSchema").cloned(),
                    })
                    .collect::<Vec<_>>(),
            )
            .map_err(|e| e.to_string())
        },
    )?;
    serde_json::from_value(result).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn mcp_stdio_call_tool(input: McpToolCall) -> Result<Value, String> {
    let timeout = timeout(input.timeout_secs);
    run_stdio_session(
        input.command,
        input.args,
        input.env_vars,
        input.cwd,
        timeout,
        |session| {
            session.request(
                "tools/call",
                json!({
                    "name": input.tool_name,
                    "arguments": input.arguments,
                }),
            )
        },
    )
}

fn timeout(timeout_secs: Option<u64>) -> Duration {
    Duration::from_secs(
        timeout_secs
            .unwrap_or(DEFAULT_TIMEOUT_SECS)
            .clamp(1, MAX_TIMEOUT_SECS),
    )
}

fn run_stdio_session<F>(
    command: String,
    args: Vec<String>,
    env_vars: HashMap<String, String>,
    cwd: Option<String>,
    timeout: Duration,
    op: F,
) -> Result<Value, String>
where
    F: FnOnce(&mut StdioSession) -> Result<Value, String>,
{
    if command.trim().is_empty() {
        return Err("MCP stdio command is empty".into());
    }

    let cwd = cwd.filter(|s| !s.trim().is_empty()).map(PathBuf::from);

    let mut session = StdioSession::spawn(command, args, env_vars, cwd, timeout)?;
    session.initialize()?;
    let result = op(&mut session);
    let _ = session.shutdown();
    result
}

struct StdioSession {
    child: Child,
    stdin: ChildStdin,
    rx: mpsc::Receiver<Result<Value, String>>,
    next_id: u64,
    timeout: Duration,
}

impl StdioSession {
    fn spawn(
        command: String,
        args: Vec<String>,
        env_vars: HashMap<String, String>,
        cwd: Option<PathBuf>,
        timeout: Duration,
    ) -> Result<Self, String> {
        let mut child = spawn_child(&command, &args, &env_vars, cwd.as_ref())?;

        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| "MCP process did not expose stdin".to_string())?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| "MCP process did not expose stdout".to_string())?;

        if let Some(stderr) = child.stderr.take() {
            thread::spawn(move || {
                let mut reader = BufReader::new(stderr);
                let mut buf = String::new();
                while reader.read_line(&mut buf).unwrap_or(0) > 0 {
                    log::debug!("mcp stderr: {}", buf.trim_end());
                    buf.clear();
                }
            });
        }

        let (tx, rx) = mpsc::channel();
        thread::spawn(move || read_stdout_loop(stdout, tx));

        Ok(Self {
            child,
            stdin,
            rx,
            next_id: 1,
            timeout,
        })
    }

    fn initialize(&mut self) -> Result<(), String> {
        self.request(
            "initialize",
            json!({
                "protocolVersion": "2024-11-05",
                "capabilities": {},
                "clientInfo": {
                    "name": "terax",
                    "version": env!("CARGO_PKG_VERSION"),
                },
            }),
        )?;
        self.notify("notifications/initialized", json!({}))
    }

    fn request(&mut self, method: &str, params: Value) -> Result<Value, String> {
        let id = self.next_id;
        self.next_id += 1;
        self.write_message(json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": method,
            "params": params,
        }))?;
        self.wait_for_response(id)
    }

    fn notify(&mut self, method: &str, params: Value) -> Result<(), String> {
        self.write_message(json!({
            "jsonrpc": "2.0",
            "method": method,
            "params": params,
        }))
    }

    fn write_message(&mut self, message: Value) -> Result<(), String> {
        // @modelcontextprotocol/sdk 1.0.x stdio transports serialize each
        // JSON-RPC message as one JSON line. This is what the Brave Search MCP
        // server uses. The reader below remains tolerant of Content-Length
        // frames for other implementations, but writes JSONL for compatibility
        // with the official 1.0.x server SDK.
        let body = serde_json::to_vec(&message).map_err(|e| e.to_string())?;
        self.stdin.write_all(&body).map_err(|e| e.to_string())?;
        self.stdin.write_all(b"\n").map_err(|e| e.to_string())?;
        self.stdin.flush().map_err(|e| e.to_string())
    }

    fn wait_for_response(&mut self, id: u64) -> Result<Value, String> {
        let started = Instant::now();
        loop {
            if started.elapsed() >= self.timeout {
                let _ = self.child.kill();
                let _ = self.child.wait();
                return Err(format!("MCP stdio request timed out after {}s", self.timeout.as_secs()));
            }

            if let Ok(Some(status)) = self.child.try_wait() {
                return Err(format!("MCP stdio process exited early with status {status}"));
            }

            match self.rx.recv_timeout(POLL_INTERVAL) {
                Ok(Ok(message)) => {
                    if message.get("id").and_then(Value::as_u64) != Some(id) {
                        continue;
                    }
                    if let Some(error) = message.get("error") {
                        return Err(format!("MCP error: {error}"));
                    }
                    return Ok(message.get("result").cloned().unwrap_or(Value::Null));
                }
                Ok(Err(err)) => return Err(err),
                Err(mpsc::RecvTimeoutError::Timeout) => {}
                Err(mpsc::RecvTimeoutError::Disconnected) => {
                    return Err("MCP stdio reader disconnected".into());
                }
            }
        }
    }

    fn shutdown(&mut self) -> Result<(), String> {
        if self.child.try_wait().map_err(|e| e.to_string())?.is_none() {
            let _ = self.child.kill();
            let _ = self.child.wait();
        }
        Ok(())
    }
}

fn spawn_child(
    command: &str,
    args: &[String],
    env_vars: &HashMap<String, String>,
    cwd: Option<&PathBuf>,
) -> Result<Child, String> {
    match build_command(command, args, env_vars, cwd).spawn() {
        Ok(child) => Ok(child),
        Err(first_err) => {
            #[cfg(target_os = "windows")]
            {
                if !command.contains('.') {
                    let cmd = format!("{command}.cmd");
                    if let Ok(child) = build_command(&cmd, args, env_vars, cwd).spawn() {
                        return Ok(child);
                    }
                }
            }
            Err(format!("failed to spawn MCP stdio command `{command}`: {first_err}"))
        }
    }
}

fn build_command(
    command: &str,
    args: &[String],
    env_vars: &HashMap<String, String>,
    cwd: Option<&PathBuf>,
) -> Command {
    let mut cmd = Command::new(command);
    cmd.args(args)
        .envs(env_vars)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Some(dir) = cwd {
        cmd.current_dir(dir);
    }
    cmd
}

fn read_stdout_loop(stdout: impl Read + Send + 'static, tx: mpsc::Sender<Result<Value, String>>) {
    let mut reader = BufReader::new(stdout);
    loop {
        match read_frame(&mut reader) {
            Ok(Some(value)) => {
                if tx.send(Ok(value)).is_err() {
                    break;
                }
            }
            Ok(None) => break,
            Err(err) => {
                let _ = tx.send(Err(err));
                break;
            }
        }
    }
}

fn read_frame<R: BufRead>(reader: &mut R) -> Result<Option<Value>, String> {
    let mut content_length: Option<usize> = None;
    let mut line = String::new();

    loop {
        line.clear();
        let read = reader.read_line(&mut line).map_err(|e| e.to_string())?;
        if read == 0 {
            return Ok(None);
        }
        let trimmed = line.trim_end_matches(['\r', '\n']);

        if content_length.is_none() && trimmed.starts_with('{') {
            return serde_json::from_str(trimmed)
                .map(Some)
                .map_err(|e| format!("invalid MCP JSON line: {e}"));
        }

        // Some third-party MCP servers incorrectly write startup logs to stdout
        // before emitting JSON-RPC frames. Tolerate and skip preamble noise
        // until either a JSON line or a Content-Length header appears.
        if content_length.is_none()
            && !trimmed.is_empty()
            && !trimmed.to_ascii_lowercase().starts_with("content-length:")
        {
            log::debug!("ignoring non-MCP stdout preamble: {trimmed}");
            continue;
        }
        if trimmed.is_empty() {
            if content_length.is_none() {
                continue;
            }
            break;
        }
        if let Some(value) = trimmed.strip_prefix("Content-Length:") {
            content_length = Some(
                value
                    .trim()
                    .parse::<usize>()
                    .map_err(|e| format!("invalid MCP Content-Length: {e}"))?,
            );
        }
    }

    let len = content_length.ok_or_else(|| "MCP frame missing Content-Length".to_string())?;
    let mut body = vec![0; len];
    reader.read_exact(&mut body).map_err(|e| e.to_string())?;
    serde_json::from_slice(&body).map_err(|e| e.to_string())
}
