import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { parse } from "smol-toml";
import { findSkills, runnable, type CliExtensionContext } from "@ai-workbench/provider-cli";
import type { ImportableMcpServer, ProviderImportables } from "@ai-workbench/provider-base";

/**
 * Servers Codex runs for its own features rather than for the person: they
 * depend on variables only Codex sets, so they cannot start anywhere else.
 */
const CODEX_ONLY = new Set(["node_repl"]);

/** The skills and MCP servers Codex already has, to use in every tool. */
export async function discoverCodexImportables(context: CliExtensionContext): Promise<ProviderImportables> {
  const home =
    context.accountHome ?? context.env["CODEX_HOME"] ?? process.env["CODEX_HOME"] ?? join(homedir(), ".codex");
  const skills = await findSkills([
    // Codex keeps skills in $CODEX_HOME/skills (its own built-ins in .system).
    { path: join(home, "skills"), source: "your Codex skills" },
    // The shared agent-skills folder several tools read.
    { path: join(homedir(), ".agents", "skills"), source: "your agent skills" },
  ]);
  return { skills, mcpServers: await readCodexMcpServers(join(home, "config.toml")) };
}

/**
 * The `[mcp_servers.<name>]` tables of a Codex config.toml. Values of `env`
 * and `http_headers` may be secrets and stay in the main process.
 */
export async function readCodexMcpServers(path: string): Promise<ImportableMcpServer[]> {
  let config: Record<string, unknown>;
  try {
    config = parse(await readFile(path, "utf8")) as Record<string, unknown>;
  } catch {
    return [];
  }
  const tables = config["mcp_servers"];
  if (!tables || typeof tables !== "object") {
    return [];
  }
  const found: ImportableMcpServer[] = [];
  for (const [name, raw] of Object.entries(tables as Record<string, unknown>)) {
    if (!raw || typeof raw !== "object" || CODEX_ONLY.has(name)) {
      continue;
    }
    const entry = raw as Record<string, unknown>;
    if (entry["enabled"] === false) {
      continue;
    }
    const url = typeof entry["url"] === "string" ? entry["url"] : undefined;
    if (url) {
      found.push({
        name,
        source: "Codex · config.toml",
        transport: "http",
        args: [],
        env: {},
        url,
        headers: strings(entry["http_headers"]),
      });
      continue;
    }
    const command = typeof entry["command"] === "string" ? entry["command"].trim() : "";
    if (!runnable(command)) {
      continue;
    }
    found.push({
      name,
      source: "Codex · config.toml",
      transport: "stdio",
      command,
      args: Array.isArray(entry["args"]) ? entry["args"].filter((arg): arg is string => typeof arg === "string") : [],
      env: strings(entry["env"]),
      headers: {},
      ...(typeof entry["cwd"] === "string" ? { cwd: entry["cwd"] } : {}),
    });
  }
  return found;
}

function strings(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
}
