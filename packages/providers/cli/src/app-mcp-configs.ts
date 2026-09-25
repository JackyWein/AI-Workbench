import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ImportableMcpServer } from "@ai-workbench/provider-base";
import { parseJsonWithComments, readJsonMcpServers, readVsCodeMcpServers } from "./mcp-configs.js";

/**
 * Editors the person may keep MCP servers in that are not tools of this
 * application: where each keeps them and in which format. Data, not code
 * per editor — adding one is a new entry here.
 */
interface AppMcpConfig {
  readonly id: string;
  readonly name: string;
  readonly files: (where: AppConfigPlaces) => ReadonlyArray<{ readonly path: string; readonly source: string }>;
  readonly format: "mcpServers" | "vscode";
}

export interface AppConfigPlaces {
  readonly home: string;
  readonly workspacePath?: string;
  readonly platform: NodeJS.Platform;
  /** %APPDATA% on Windows. */
  readonly appData?: string;
}

const APPS: readonly AppMcpConfig[] = [
  {
    id: "cursor",
    name: "Cursor",
    format: "mcpServers",
    files: ({ home, workspacePath }) => [
      { path: join(home, ".cursor", "mcp.json"), source: "Cursor · your servers" },
      ...(workspacePath ? [{ path: join(workspacePath, ".cursor", "mcp.json"), source: "Cursor · this project" }] : []),
    ],
  },
  {
    id: "vscode",
    name: "VS Code",
    format: "vscode",
    files: ({ home, workspacePath, platform, appData }) => [
      { path: join(vsCodeUserDirectory(home, platform, appData), "mcp.json"), source: "VS Code · your servers" },
      ...(workspacePath ? [{ path: join(workspacePath, ".vscode", "mcp.json"), source: "VS Code · this project" }] : []),
    ],
  },
  {
    id: "windsurf",
    name: "Windsurf",
    format: "mcpServers",
    files: ({ home }) => [
      { path: join(home, ".codeium", "windsurf", "mcp_config.json"), source: "Windsurf · your servers" },
    ],
  },
];

function vsCodeUserDirectory(home: string, platform: NodeJS.Platform, appData: string | undefined): string {
  if (platform === "win32") {
    return join(appData ?? join(home, "AppData", "Roaming"), "Code", "User");
  }
  if (platform === "darwin") {
    return join(home, "Library", "Application Support", "Code", "User");
  }
  return join(home, ".config", "Code", "User");
}

/** The MCP servers kept in the editors above, each under the editor's name. */
export async function discoverAppMcpServers(
  places: Partial<AppConfigPlaces> = {},
): Promise<Array<{ readonly appId: string; readonly appName: string; readonly servers: ImportableMcpServer[] }>> {
  const where: AppConfigPlaces = {
    home: places.home ?? homedir(),
    platform: places.platform ?? process.platform,
    ...(places.workspacePath ? { workspacePath: places.workspacePath } : {}),
    ...((places.appData ?? process.env["APPDATA"]) ? { appData: places.appData ?? process.env["APPDATA"] } : {}),
  };
  const found = [];
  for (const app of APPS) {
    const servers: ImportableMcpServer[] = [];
    for (const file of app.files(where)) {
      let config: unknown;
      try {
        config = parseJsonWithComments(await readFile(file.path, "utf8"));
      } catch {
        continue;
      }
      servers.push(
        ...(app.format === "vscode"
          ? readVsCodeMcpServers(config, file.source)
          : readJsonMcpServers((config as Record<string, unknown> | null)?.["mcpServers"], file.source)),
      );
    }
    if (servers.length > 0) {
      found.push({ appId: app.id, appName: app.name, servers });
    }
  }
  return found;
}
