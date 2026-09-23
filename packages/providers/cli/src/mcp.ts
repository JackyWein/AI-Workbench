import type { ProviderToolAccess } from "@ai-workbench/provider-base";
import { substitute, type CliMcp } from "./profile.js";

/** One MCP server a session hands to the tool (spec §36, §38). */
export type CliMcpServer = ProviderToolAccess["mcpServers"][number];

/** What a run needs on top of its own arguments and environment. */
export interface CliMcpLaunch {
  readonly args: string[];
  readonly env: Record<string, string>;
}

export const NO_MCP: CliMcpLaunch = { args: [], env: {} };

/**
 * The servers the tool connects to itself. Host-mediated tools are executed by
 * the application and never reach the tool's command line.
 */
export function mcpServersFor(toolAccess: ProviderToolAccess | undefined): CliMcpServer[] {
  return toolAccess?.kind === "provider-mcp" ? [...toolAccess.mcpServers] : [];
}

/**
 * Adds a scoped extra server — the team MCP server — to the servers a CLI
 * call is handed (spec §42). The entry replaces any same-named one, so a
 * stale server in the tool's own configuration can never shadow the scoped
 * connection. Without an entry the list passes through unchanged.
 */
export function withTeamMcpServer(
  servers: readonly CliMcpServer[],
  team: CliMcpServer | null | undefined,
): CliMcpServer[] {
  if (!team) {
    return [...servers];
  }
  return [...servers.filter((server) => server.id !== team.id), team];
}

/**
 * Writes the servers in the form the profile names (spec §36, §38). Each
 * strategy is a configuration format several tools share, so a tool is a
 * choice of strategy in its profile rather than code here. A tool whose format
 * none of them writes uses `via: "extension"`, handled by the caller.
 */
export function buildMcpLaunch(mcp: CliMcp, servers: readonly CliMcpServer[]): CliMcpLaunch {
  if (servers.length === 0) {
    return NO_MCP;
  }
  switch (mcp.via) {
    case "none":
    case "extension":
      return NO_MCP;
    case "json-arg": {
      const map = commonServerMap(servers);
      if (!map) {
        return NO_MCP;
      }
      // The rest of each argument (a flag, or a `--flag=` prefix) is kept as
      // written; only `{mcpConfig}` is replaced.
      const args = substitute(mcp.args, { mcpConfig: JSON.stringify({ mcpServers: map }) });
      return args ? { args, env: {} } : NO_MCP;
    }
    case "env-json": {
      const map = commonServerMap(servers);
      return map
        ? { args: [], env: { [mcp.variable]: JSON.stringify({ [mcp.root]: map }) } }
        : NO_MCP;
    }
    case "config-overrides":
      return { args: configOverrides(mcp.flag, mcp.root, servers), env: {} };
  }
}

/**
 * The `{"<id>": {...}}` map most tools read: `command`/`args`/`env` for a
 * local server, `type`/`url`/`headers` for a remote one.
 */
function commonServerMap(
  servers: readonly CliMcpServer[],
): Record<string, unknown> | null {
  const map: Record<string, unknown> = {};
  for (const server of servers) {
    if (isRemote(server)) {
      if (!server.url) {
        continue;
      }
      const headers = headersOf(server);
      map[server.id] = {
        type: server.transport,
        url: server.url,
        ...(headers ? { headers } : {}),
      };
      continue;
    }
    if (!server.command) {
      continue;
    }
    const env = server.env ?? {};
    map[server.id] = {
      command: server.command,
      args: [...(server.args ?? [])],
      ...(Object.keys(env).length > 0 ? { env: { ...env } } : {}),
    };
  }
  return Object.keys(map).length > 0 ? map : null;
}

/**
 * One `flag root.<id>.<key>=<value>` pair per setting. Values are TOML: a JSON
 * string is a valid TOML basic string and a JSON array of strings a valid TOML
 * array, and tables are written inline. Ids are reduced to what a bare TOML
 * key may contain, so a server id can never open another key path.
 */
function configOverrides(
  flag: string,
  root: string,
  servers: readonly CliMcpServer[],
): string[] {
  const args: string[] = [];
  const used = new Set<string>();
  const set = (key: string, value: string): void => {
    args.push(flag, `${key}=${value}`);
  };

  for (const server of servers) {
    const remote = isRemote(server);
    if (remote ? !server.url : !server.command) {
      continue;
    }
    const prefix = `${root}.${uniqueKey(server.id, used)}`;

    if (remote) {
      set(`${prefix}.url`, JSON.stringify(server.url));
      const headers = headersOf(server);
      if (headers) {
        set(`${prefix}.http_headers`, tomlInlineTable(headers));
      }
      continue;
    }

    set(`${prefix}.command`, JSON.stringify(server.command));
    // Written even when empty, so arguments a same-named server in the tool's
    // own configuration has are not merged into this one.
    set(`${prefix}.args`, JSON.stringify([...(server.args ?? [])]));
    const env = server.env ?? {};
    if (Object.keys(env).length > 0) {
      set(`${prefix}.env`, tomlInlineTable(env));
    }
  }
  return args;
}

function uniqueKey(id: string, used: Set<string>): string {
  const base = id.replace(/[^A-Za-z0-9_-]/g, "_") || "server";
  let key = base;
  for (let suffix = 2; used.has(key); suffix += 1) {
    key = `${base}_${suffix}`;
  }
  used.add(key);
  return key;
}

function tomlInlineTable(values: Readonly<Record<string, string>>): string {
  const entries = Object.entries(values).map(
    ([key, value]) => `${JSON.stringify(key)} = ${JSON.stringify(value)}`,
  );
  return `{${entries.join(", ")}}`;
}

function isRemote(server: CliMcpServer): boolean {
  return server.transport === "http" || server.transport === "sse";
}

/** Request headers a remote server is reached with, when it has any. */
function headersOf(server: CliMcpServer): Record<string, string> | null {
  const headers = server.headers ?? {};
  return Object.keys(headers).length > 0 ? { ...headers } : null;
}
