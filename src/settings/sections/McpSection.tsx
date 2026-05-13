import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import {
  usePreferencesStore,
} from "@/modules/settings/preferences";
import { setMcpServers, type McpServerConfig } from "@/modules/settings/store";
import {
  Add01Icon,
  Delete02Icon,
  Edit02Icon,
  McpServerIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useEffect, useState } from "react";
import { SectionHeader } from "../components/SectionHeader";

function generateId(): string {
  return `mcp_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

export function McpSection() {
  const mcpServers = usePreferencesStore((s) => s.mcpServers);

  const [editing, setEditing] = useState<McpServerConfig | null>(null);

  const upsertServer = (server: McpServerConfig) => {
    const existing = mcpServers.find((s) => s.id === server.id);
    const updated = existing
      ? mcpServers.map((s) => (s.id === server.id ? server : s))
      : [...mcpServers, server];
    void setMcpServers(updated);
    setEditing(null);
  };

  const removeServer = (id: string) => {
    void setMcpServers(mcpServers.filter((s) => s.id !== id));
  };

  const toggleServer = (id: string) => {
    void setMcpServers(
      mcpServers.map((s) => (s.id === id ? { ...s, enabled: !s.enabled } : s)),
    );
  };

  return (
    <div className="flex flex-col gap-6">
      <SectionHeader
        title="MCP Servers"
        description="Configure local or remote MCP servers. The agent can use their tools via the MCP protocol."
      />

      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between">
          <Label>Servers</Label>
          <Button
            size="sm"
            variant="outline"
            className="h-7 gap-1.5 px-2 text-[11px]"
            onClick={() =>
              setEditing({
                id: generateId(),
                name: "",
                transport: "stdio",
                command: "",
                args: [],
                envVars: {},
                url: "",
                headers: {},
                enabled: true,
              })
            }
          >
            <HugeiconsIcon icon={Add01Icon} size={12} strokeWidth={1.75} />
            Add server
          </Button>
        </div>

        {mcpServers.length === 0 ? (
          <div className="rounded-lg border border-dashed border-border/60 bg-card/30 px-4 py-6 text-center text-[11px] text-muted-foreground">
            No MCP servers configured. Add one to extend the agent's capabilities.
          </div>
        ) : (
          <ul className="flex flex-col gap-1.5">
            {mcpServers.map((server) => (
              <li
                key={server.id}
                className={cn(
                  "flex items-center gap-2 rounded-lg border border-border/60 bg-card/60 px-3 py-2.5 transition-opacity",
                  !server.enabled && "opacity-50",
                )}
              >
                <div className="flex size-7 shrink-0 items-center justify-center rounded-md bg-muted/40">
                  <HugeiconsIcon icon={McpServerIcon} size={14} strokeWidth={1.5} />
                </div>
                <div className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate text-[12.5px] font-medium">
                    {server.name || "(unnamed)"}
                  </span>
                  <span className="truncate text-[10.5px] text-muted-foreground">
                    {server.transport === "stdio"
                      ? server.command || "—no command"
                      : server.url || "—no URL"}
                  </span>
                </div>
                <div className="flex items-center gap-1">
                  <Button
                    size="xs"
                    variant={server.enabled ? "default" : "outline"}
                    onClick={() => toggleServer(server.id)}
                    className="h-6 gap-1 px-2 text-[10.5px]"
                  >
                    {server.enabled ? "Enabled" : "Disabled"}
                  </Button>
                  <Button
                    size="icon"
                    variant="ghost"
                    className="size-7"
                    onClick={() => setEditing(server)}
                    title="Edit"
                  >
                    <HugeiconsIcon icon={Edit02Icon} size={12} strokeWidth={1.75} />
                  </Button>
                  <Button
                    size="icon"
                    variant="ghost"
                    className="size-7 text-muted-foreground hover:text-destructive"
                    onClick={() => removeServer(server.id)}
                    title="Delete"
                  >
                    <HugeiconsIcon icon={Delete02Icon} size={12} strokeWidth={1.75} />
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      <McpServerEditorDialog
        server={editing}
        onClose={() => setEditing(null)}
        onSave={upsertServer}
      />
    </div>
  );
}

function McpServerEditorDialog({
  server,
  onClose,
  onSave,
}: {
  server: McpServerConfig | null;
  onClose: () => void;
  onSave: (s: McpServerConfig) => void;
}) {
  const [draft, setDraft] = useState<McpServerConfig | null>(null);

  useEffect(() => {
    if (server) {
      setDraft({ ...server, args: server.args ?? [], envVars: server.envVars ?? {}, headers: server.headers ?? {} });
    }
  }, [server]);

  if (!draft) return null;

  const canSave =
    draft.name.trim().length > 0 &&
    (draft.transport === "http"
      ? draft.url.trim().length > 0
      : draft.command.trim().length > 0);

  return (
    <Dialog open={!!server} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="text-[14px]">
            {server?.command ? "Edit server" : "Add server"}
          </DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1">
            <Label>Name</Label>
            <Input
              value={draft.name}
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              placeholder="e.g. Filesystem, Git, Slack"
              className="h-8 text-[12px]"
            />
          </div>

          <div className="flex flex-col gap-1">
            <Label>Transport</Label>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => setDraft({ ...draft, transport: "stdio" })}
                className={cn(
                  "flex flex-1 items-center justify-center gap-2 rounded-md border py-2 text-[11.5px] transition-colors",
                  draft.transport === "stdio"
                    ? "border-foreground/40 bg-accent"
                    : "border-border/60 hover:bg-accent/40",
                )}
              >
                <HugeiconsIcon icon={McpServerIcon} size={12} strokeWidth={1.75} />
                stdio (local)
              </button>
              <button
                type="button"
                onClick={() => setDraft({ ...draft, transport: "http" })}
                className={cn(
                  "flex flex-1 items-center justify-center gap-2 rounded-md border py-2 text-[11.5px] transition-colors",
                  draft.transport === "http"
                    ? "border-foreground/40 bg-accent"
                    : "border-border/60 hover:bg-accent/40",
                )}
              >
                HTTP / SSE
              </button>
            </div>
          </div>

          {draft.transport === "stdio" ? (
            <>
              <div className="flex flex-col gap-1">
                <Label>Command</Label>
                <Input
                  value={draft.command}
                  onChange={(e) => setDraft({ ...draft, command: e.target.value })}
                  placeholder="e.g. npx, /usr/local/bin/mcp-server"
                  className="h-8 font-mono text-[12px]"
                />
              </div>
              <div className="flex flex-col gap-1">
                <Label>Arguments</Label>
                <Input
                  value={draft.args.join(" ")}
                  onChange={(e) =>
                    setDraft({
                      ...draft,
                      args: e.target.value.trim() ? e.target.value.trim().split(/\s+/) : [],
                    })
                  }
                  placeholder="e.g. --flag value (space-separated)"
                  className="h-8 font-mono text-[12px]"
                />
              </div>
              <div className="flex flex-col gap-1">
                <Label>Environment variables</Label>
                <Textarea
                  value={Object.entries(draft.envVars)
                    .map(([k, v]) => `${k}=${v}`)
                    .join("\n")}
                  onChange={(e) => {
                    const env: Record<string, string> = {};
                    for (const line of e.target.value.split("\n")) {
                      const eq = line.indexOf("=");
                      if (eq > 0) {
                        env[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
                      }
                    }
                    setDraft({ ...draft, envVars: env });
                  }}
                  placeholder="KEY=value (one per line)"
                  className="min-h-20 resize-y font-mono text-[11.5px] leading-relaxed"
                />
              </div>
            </>
          ) : (
            <>
              <div className="flex flex-col gap-1">
                <Label>URL</Label>
                <Input
                  value={draft.url}
                  onChange={(e) => setDraft({ ...draft, url: e.target.value })}
                  placeholder="https://example.com/mcp"
                  className="h-8 font-mono text-[12px]"
                />
              </div>
              <div className="flex flex-col gap-1">
                <Label>Headers (optional)</Label>
                <Textarea
                  value={Object.entries(draft.headers)
                    .map(([k, v]) => `${k}: ${v}`)
                    .join("\n")}
                  onChange={(e) => {
                    const hdrs: Record<string, string> = {};
                    for (const line of e.target.value.split("\n")) {
                      const colon = line.indexOf(":");
                      if (colon > 0) {
                        hdrs[line.slice(0, colon).trim()] = line.slice(colon + 1).trim();
                      }
                    }
                    setDraft({ ...draft, headers: hdrs });
                  }}
                  placeholder="Authorization: Bearer token (one per line)"
                  className="min-h-20 resize-y font-mono text-[11.5px] leading-relaxed"
                />
              </div>
            </>
          )}
        </div>
        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button
            size="sm"
            disabled={!canSave}
            onClick={() => onSave({ ...draft })}
          >
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Label({ children }: { children: React.ReactNode }) {
  return (
    <span className="text-[11px] font-medium tracking-tight text-muted-foreground">
      {children}
    </span>
  );
}