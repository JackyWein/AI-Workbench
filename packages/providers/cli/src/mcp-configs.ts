import type { ImportableMcpServer } from "@ai-workbench/provider-base";

/**
 * Reads MCP servers written in the format most tools share —
 * `{"<name>": {"command", "args", "env"} | {"type": "http"|"sse", "url",
 * "headers"}}` — as Claude Code, Claude Desktop, Gemini CLI and Cursor keep
 * them. Values of `env` and `headers` may be secrets: they are returned for
 * the main process to move into secure storage and are never logged here.
 *
 * An entry that cannot run — no command, a url that is not one — is left
 * out rather than offered for import and failing later.
 */
export function readJsonMcpServers(servers: unknown, source: string): ImportableMcpServer[] {
  if (!servers || typeof servers !== "object" || Array.isArray(servers)) {
    return [];
  }
  const found: ImportableMcpServer[] = [];
  for (const [name, raw] of Object.entries(servers as Record<string, unknown>)) {
    if (!raw || typeof raw !== "object") {
      continue;
    }
    const entry = raw as Record<string, unknown>;
    if (entry["disabled"] === true || entry["enabled"] === false) {
      continue;
    }
    const type = typeof entry["type"] === "string" ? entry["type"] : undefined;
    const url =
      typeof entry["url"] === "string"
        ? entry["url"]
        : typeof entry["httpUrl"] === "string"
          ? entry["httpUrl"]
          : undefined;
    const env = stringRecord(entry["env"]);
    const headers = stringRecord(entry["headers"]);

    if (url && (type === "http" || type === "sse" || type === "streamable-http" || !entry["command"])) {
      if (!isUrl(url)) {
        continue;
      }
      found.push({
        name,
        source,
        transport: type === "sse" ? "sse" : "http",
        args: [],
        env: {},
        url,
        headers,
      });
      continue;
    }

    const command = typeof entry["command"] === "string" ? entry["command"].trim() : "";
    if (!runnable(command)) {
      continue;
    }
    found.push({
      name,
      source,
      transport: "stdio",
      command,
      args: Array.isArray(entry["args"])
        ? entry["args"].filter((arg): arg is string => typeof arg === "string")
        : [],
      env,
      headers: {},
      ...(typeof entry["cwd"] === "string" ? { cwd: entry["cwd"] } : {}),
    });
  }
  return found;
}

/** A command that could start something: not empty, not a lone separator. */
export function runnable(command: string): boolean {
  return command.length > 1 && !/^[\\/.]+$/.test(command);
}

function isUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function stringRecord(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  const result: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (typeof entry === "string") {
      result[key] = entry;
    }
  }
  return result;
}
