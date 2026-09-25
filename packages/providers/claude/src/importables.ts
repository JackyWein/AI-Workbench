import { homedir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import {
  findSkillsDeep,
  readJsonFile,
  readJsonMcpServers,
  type CliExtensionContext,
} from "@ai-workbench/provider-cli";
import type {
  ImportableMcpServer,
  ImportableSkill,
  ProviderImportables,
} from "@ai-workbench/provider-base";
import { configHomeOf } from "./telemetry.js";

/**
 * Everything Claude Code already has that the other tools could use too: the
 * person's own skills, those synced from their organisation, every plugin's
 * skills and the project's; the MCP servers of the account, of this project
 * and of Claude Desktop.
 */
export async function discoverClaudeImportables(
  context: CliExtensionContext,
  request: { readonly workspacePath?: string },
): Promise<ProviderImportables> {
  const home = configHomeOf(context);
  const skills = [
    ...(await findSkillsDeep(join(home, "skills"), (path) =>
      path.includes(`${sep}synced${sep}`) ? "Claude · synced from your organisation" : "Claude Code · your skills",
    )),
    ...(await installedPluginSkills(home)),
    // Plugins synced from the person's organisation live beside the installed ones.
    ...(await findSkillsDeep(join(home, "plugins", "synced"), (path) => `Claude Code · plugin ${pluginName(join(home, "plugins"), path)}`)),
    ...(request.workspacePath
      ? await findSkillsDeep(join(request.workspacePath, ".claude", "skills"), () => "Claude Code · this project")
      : []),
  ];

  // The default home keeps its settings next to it (~/.claude.json); any
  // other account keeps them inside its own folder.
  const settingsFile =
    resolve(home) === resolve(join(homedir(), ".claude"))
      ? join(homedir(), ".claude.json")
      : join(home, ".claude.json");
  const settings = (await readJsonFile(settingsFile)) as Record<string, unknown> | null;
  const mcpServers: ImportableMcpServer[] = [
    ...readJsonMcpServers(settings?.["mcpServers"], "Claude Code · your servers"),
  ];
  if (request.workspacePath && settings?.["projects"] && typeof settings["projects"] === "object") {
    const wanted = normalize(request.workspacePath);
    for (const [path, project] of Object.entries(settings["projects"] as Record<string, unknown>)) {
      if (normalize(path) === wanted && project && typeof project === "object") {
        mcpServers.push(
          ...readJsonMcpServers((project as Record<string, unknown>)["mcpServers"], "Claude Code · this project"),
        );
      }
    }
  }
  // The project's shared file is the project's own: it counts whether or not
  // the person's settings know the project.
  if (request.workspacePath) {
    const shared = (await readJsonFile(join(request.workspacePath, ".mcp.json"))) as Record<string, unknown> | null;
    mcpServers.push(...readJsonMcpServers(shared?.["mcpServers"], "Claude Code · .mcp.json"));
  }
  const desktop = (await readJsonFile(claudeDesktopConfig())) as Record<string, unknown> | null;
  mcpServers.push(...readJsonMcpServers(desktop?.["mcpServers"], "Claude Desktop"));

  return { skills, mcpServers };
}

/**
 * Skills of the plugins Claude Code has installed, as its own
 * installed_plugins.json lists them. The marketplace folders next to them
 * hold every plugin that could be installed, so they are not a source: only
 * what the person installed counts. A plugin installed for one project only
 * says so.
 */
async function installedPluginSkills(home: string): Promise<ImportableSkill[]> {
  const manifest = (await readJsonFile(join(home, "plugins", "installed_plugins.json"))) as
    | { plugins?: Record<string, unknown> }
    | null;
  const plugins = manifest?.plugins;
  if (!plugins || typeof plugins !== "object") {
    return [];
  }
  const found: ImportableSkill[] = [];
  for (const [key, installs] of Object.entries(plugins)) {
    const name = key.split("@")[0] ?? key;
    for (const install of Array.isArray(installs) ? installs : []) {
      if (!install || typeof install !== "object") {
        continue;
      }
      const entry = install as Record<string, unknown>;
      const path = typeof entry["installPath"] === "string" ? entry["installPath"] : null;
      if (!path) {
        continue;
      }
      const project =
        entry["scope"] === "local" && typeof entry["projectPath"] === "string"
          ? ` (only in ${entry["projectPath"].split(/[\\/]/).pop() ?? "one project"})`
          : "";
      found.push(...(await findSkillsDeep(path, () => `Claude Code · plugin ${name}${project}`)));
    }
  }
  return found;
}

/** "cache/<marketplace>/<plugin>/…" or "marketplaces/<name>/…" → the plugin's name. */
function pluginName(root: string, path: string): string {
  const parts = relative(root, path).split(/[\\/]/);
  if (parts[0] === "cache" || parts[0] === "synced") {
    return parts[2] ?? parts[1] ?? "plugin";
  }
  return parts[1] ?? "plugin";
}

function normalize(path: string): string {
  const value = resolve(path).replace(/[\\/]+$/, "");
  return process.platform === "win32" ? value.replace(/\//g, "\\").toLowerCase() : value;
}

function claudeDesktopConfig(): string {
  if (process.platform === "win32") {
    return join(process.env["APPDATA"] ?? join(homedir(), "AppData", "Roaming"), "Claude", "claude_desktop_config.json");
  }
  if (process.platform === "darwin") {
    return join(homedir(), "Library", "Application Support", "Claude", "claude_desktop_config.json");
  }
  return join(homedir(), ".config", "Claude", "claude_desktop_config.json");
}
