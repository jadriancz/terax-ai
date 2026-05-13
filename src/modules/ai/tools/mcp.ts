import { tool } from "ai";
import { invoke } from "@tauri-apps/api/core";
import { z } from "zod";
import type { McpServerConfig } from "@/modules/settings/store";
import type { ToolContext } from "./context";
import type { Tool } from "ai";

/**
 * Browser/WebView code cannot spawn stdio MCP processes directly. HTTP/SSE MCP
 * servers use `@ai-sdk/mcp`; stdio MCP servers are proxied through Tauri/Rust,
 * which owns process spawning and stdin/stdout framing.
 */
export function buildMcpTools(
  ctx: ToolContext,
  servers: McpServerConfig[],
): Record<string, Tool> {
  const enabledServers = servers.filter((s) => s.enabled);
  if (enabledServers.length === 0) return {};

  const tools: Record<string, Tool> = {};

  for (const server of enabledServers) {
    const baseName = `mcp_${server.name.toLowerCase().replace(/[^a-z0-9_]/g, "_").replace(/__+/g, "_")}`;
    if (server.transport === "stdio") {
      tools[`${baseName}_dispatch`] = tool({
        description: `[MCP server: ${server.name}] Dispatch to any tool on the ${server.name} MCP stdio server. For Brave Search, common tools are "brave_web_search" and "brave_local_search". Pass the MCP tool name and its arguments.`,
        inputSchema: z.object({
          tool: z.string().describe("The MCP tool name to call"),
          args: z.record(z.string(), z.unknown()).default({}).describe("Arguments to pass to the MCP tool"),
        }),
        needsApproval: true,
        execute: async ({ tool: toolName, args }) => {
          try {
            const result = await invoke("mcp_stdio_call_tool", {
              input: {
                command: server.command,
                args: server.args,
                envVars: envVarsFor(server),
                toolName,
                arguments: args ?? {},
                cwd: ctx.getCwd?.() ?? null,
                timeoutSecs: 60,
              },
            });
            return result;
          } catch (err) {
            return { error: `MCP ${server.name} stdio error: ${String(err)}` };
          }
        },
      });
      continue;
    }

    tools[`${baseName}_dispatch`] = tool({
      description: `[MCP server: ${server.name}] Dispatch to any tool on the ${server.name} MCP server (HTTP). Pass the tool name and arguments as defined by the server.`,
      inputSchema: z.object({
        tool: z.string().describe("The MCP tool name to call"),
        args: z.record(z.string(), z.unknown()).describe("Arguments to pass to the MCP tool"),
      }),
      needsApproval: true,
      execute: async ({ tool: toolName, args }) => {
        try {
          const { createMCPClient } = await import("@ai-sdk/mcp");
          const client = await createMCPClient({
            transport: {
              type: "http",
              url: server.url,
              headers: server.headers,
            },
            clientName: `terax-mcp-${server.id}`,
            version: "1.0.0",
          });

          const mcpToolSet = await client.tools();
          const found = mcpToolSet[toolName as keyof typeof mcpToolSet];
          if (!found) {
            const available = Object.keys(mcpToolSet);
            return {
              error: `Unknown MCP tool "${toolName}" on server "${server.name}". Available tools: ${available.join(", ") || "none"}`,
            };
          }

          const result = await found.execute(args as Record<string, unknown>, {
            messages: [],
            toolCallId: `mcp-${server.id}-${toolName}`,
          });
          return result;
        } catch (err) {
          return { error: `MCP ${server.name} error: ${String(err)}` };
        }
      },
    });
  }

  return tools;
}

function envVarsFor(server: McpServerConfig): Record<string, string> {
  const maybeLegacy = server as McpServerConfig & {
    env?: Record<string, string>;
  };
  return server.envVars ?? maybeLegacy.env ?? {};
}
