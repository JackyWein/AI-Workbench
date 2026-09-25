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
    // `serverUrl` is how Windsurf and Antigravity name a remote server's address.
    const url =
      typeof entry["url"] === "string"
        ? entry["url"]
        : typeof entry["httpUrl"] === "string"
          ? entry["httpUrl"]
          : typeof entry["serverUrl"] === "string"
            ? entry["serverUrl"]
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

/**
 * Reads VS Code's `mcp.json`: `{"servers": {"<name>": {"type": "stdio",
 * "command", "args", "env"} | {"type": "http"|"sse", "url", "headers"}}}`.
 * A value that asks VS Code for an input when the server starts
 * (`${input:…}`) is not a value and is left out.
 */
export function readVsCodeMcpServers(config: unknown, source: string): ImportableMcpServer[] {
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    return [];
  }
  const servers = (config as Record<string, unknown>)["servers"];
  return readJsonMcpServers(withoutInputs(servers), source);
}

/**
 * Reads OpenCode's configuration: `{"mcp": {"<name>": {"type": "local",
 * "command": [...], "environment": {...}} | {"type": "remote", "url",
 * "headers"}}}`, each with an optional `enabled`.
 */
export function readOpenCodeMcpServers(config: unknown, source: string): ImportableMcpServer[] {
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    return [];
  }
  const servers = (config as Record<string, unknown>)["mcp"];
  if (!servers || typeof servers !== "object" || Array.isArray(servers)) {
    return [];
  }
  const found: ImportableMcpServer[] = [];
  for (const [name, raw] of Object.entries(servers as Record<string, unknown>)) {
    if (!raw || typeof raw !== "object") {
      continue;
    }
    const entry = raw as Record<string, unknown>;
    if (entry["enabled"] === false) {
      continue;
    }
    if (entry["type"] === "remote" && typeof entry["url"] === "string" && isUrl(entry["url"])) {
      found.push({
        name,
        source,
        transport: "http",
        args: [],
        env: {},
        url: entry["url"],
        headers: stringRecord(entry["headers"]),
      });
      continue;
    }
    const command = Array.isArray(entry["command"])
      ? entry["command"].filter((part): part is string => typeof part === "string")
      : [];
    const [program, ...args] = command;
    if (!program || !runnable(program.trim())) {
      continue;
    }
    found.push({
      name,
      source,
      transport: "stdio",
      command: program.trim(),
      args,
      env: stringRecord(entry["environment"]),
      headers: {},
    });
  }
  return found;
}

/**
 * Parses JSON that may carry comments and trailing commas, as VS Code's and
 * OpenCode's files may. Strings are left exactly as they are.
 */
export function parseJsonWithComments(text: string): unknown {
  let out = "";
  let inString = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index] ?? "";
    const next = text[index + 1] ?? "";
    if (inString) {
      out += char;
      if (char === "\\") {
        out += next;
        index += 1;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
      out += char;
    } else if (char === "/" && next === "/") {
      while (index < text.length && text[index] !== "\n") {
        index += 1;
      }
      out += "\n";
    } else if (char === "/" && next === "*") {
      index += 2;
      while (index < text.length && !(text[index] === "*" && text[index + 1] === "/")) {
        index += 1;
      }
      index += 1;
    } else {
      out += char;
    }
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, "$1"));
}

function withoutInputs(servers: unknown): unknown {
  if (!servers || typeof servers !== "object" || Array.isArray(servers)) {
    return servers;
  }
  const cleaned: Record<string, unknown> = {};
  for (const [name, raw] of Object.entries(servers as Record<string, unknown>)) {
    if (!raw || typeof raw !== "object") {
      continue;
    }
    const entry = { ...(raw as Record<string, unknown>) };
    for (const field of ["env", "headers"]) {
      const values = entry[field];
      if (values && typeof values === "object" && !Array.isArray(values)) {
        entry[field] = Object.fromEntries(
          Object.entries(values as Record<string, unknown>).filter(
            ([, value]) => typeof value !== "string" || !value.includes("${input:"),
          ),
        );
      }
    }
    cleaned[name] = entry;
  }
  return cleaned;
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
