import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ImportableMcpServer } from "@ai-workbench/provider-base";
import { ANTIGRAVITY_MEMORY_SERVER_NAME } from "./antigravity-memory.js";
import type { CliProviderExtensions } from "./extensions.js";
import { parseJsonWithComments, readJsonMcpServers } from "./mcp-configs.js";

/**
 * Where Antigravity keeps its MCP servers. Google documents both paths for
 * CLI releases; `agy mcp add` writes the first.
 */
export function antigravityMcpConfigPaths(home: string = homedir()): string[] {
  return [
    join(home, ".gemini", "config", "mcp_config.json"),
    join(home, ".gemini", "antigravity-cli", "mcp_config.json"),
  ];
}

/** Antigravity's MCP servers, without the entry this application keeps there itself. */
export async function discoverAntigravityMcpServers(home: string = homedir()): Promise<ImportableMcpServer[]> {
  const found: ImportableMcpServer[] = [];
  for (const path of antigravityMcpConfigPaths(home)) {
    let config: unknown;
    try {
      config = parseJsonWithComments(await readFile(path, "utf8"));
    } catch {
      continue;
    }
    found.push(
      ...readJsonMcpServers((config as Record<string, unknown> | null)?.["mcpServers"], "Antigravity · your servers")
        .filter((server) => server.name !== ANTIGRAVITY_MEMORY_SERVER_NAME),
    );
  }
  return found;
}

/** What Antigravity needs beyond its profile data. */
export const antigravityExtensions: CliProviderExtensions = {
  discoverImportables: async () => ({ skills: [], mcpServers: await discoverAntigravityMcpServers() }),
};
