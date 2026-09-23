import type { ProviderToolAccess } from "@ai-workbench/provider-base";

type Server = ProviderToolAccess["mcpServers"][number];

/**
 * OpenCode reads extra configuration from OPENCODE_CONFIG_CONTENT and merges
 * it over the person's own, so the servers come in without touching their
 * files. Checked against OpenCode 1.18: `opencode mcp list` shows both kinds.
 */
export function opencodeMcpLaunch(servers: readonly Server[]): {
  args: string[];
  env: Record<string, string>;
} {
  const mcp = opencodeServerMap(servers);
  return Object.keys(mcp).length === 0
    ? { args: [], env: {} }
    : { args: [], env: { OPENCODE_CONFIG_CONTENT: JSON.stringify({ mcp }) } };
}

/**
 * Servers in OpenCode's shape: "local" with the command as one list, or
 * "remote". A remote server reached with a key of ours has OpenCode's own
 * sign-in switched off: the key is the sign-in.
 */
export function opencodeServerMap(servers: readonly Server[]): Record<string, unknown> {
  const map: Record<string, unknown> = {};
  for (const server of servers) {
    if ((server.transport === "http" || server.transport === "sse") && server.url) {
      const headers = server.headers && Object.keys(server.headers).length > 0 ? { ...server.headers } : null;
      map[server.id] = {
        type: "remote",
        url: server.url,
        enabled: true,
        ...(headers ? { headers, oauth: false } : {}),
      };
    } else if (server.command) {
      map[server.id] = {
        type: "local",
        command: [server.command, ...(server.args ?? [])],
        enabled: true,
        ...(server.env && Object.keys(server.env).length > 0 ? { environment: { ...server.env } } : {}),
      };
    }
  }
  return map;
}
