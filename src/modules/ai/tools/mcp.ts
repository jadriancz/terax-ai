import { tool } from "ai";
import { z } from "zod";
import type { McpServerConfig } from "@/modules/settings/store";
import type { ToolContext } from "./context";
import type { Tool } from "ai";

/**
 * WARNING: `@ai-sdk/mcp` stdio transport requires Node.js `child_process.spawn` —
 * it cannot run in a browser/WebView context. Only HTTP/SSE MCP servers are
 * functional in the Tauri desktop app. The stdio code path is stubbed out.
 */
export function buildMcpTools(
  _ctx: ToolContext,
  servers: McpServerConfig[],
): Record<string, Tool> {
  const httpServers = servers.filter((s) => s.enabled && s.transport === "http");
  if (httpServers.length === 0) return {};

  const tools: Record<string, Tool> = {};

  for (const server of httpServers) {
    const baseName = `mcp_${server.name.toLowerCase().replace(/[^a-z0-9_]/g, "_").replace(/__+/g, "_")}`;

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