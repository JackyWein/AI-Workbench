import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { parseMcpServerConfig } from "@ai-workbench/shared";
import { AntigravityMemoryBridge } from "../packages/providers/cli/src/antigravity-memory.js";
import { execCli, findExecutable } from "@ai-workbench/transport-cli";

const tool = await findExecutable("agy", { knownLocations: ["%LOCALAPPDATA%/agy/bin/agy.exe"] });
if (!tool) {
  console.log("SKIP: Antigravity CLI is not installed; no provider request was made.");
  process.exit(0);
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const electron = require("electron") as string;
const script = join(root, "apps", "desktop", "out", "main", "memory-server.js");
const home = await mkdtemp(join(tmpdir(), "ai-workbench-agy-check-"));
const vault = join(home, "vault");
await mkdir(vault);
await writeFile(join(vault, "Proof.md"), "# Proof\n\nShared memory check.\n");
const env = { ...process.env, HOME: home, USERPROFILE: home };
const bridge = new AntigravityMemoryBridge({
  home, env, executablePath: tool.path, expectedCommand: electron, expectedScript: script,
});
const server = parseMcpServerConfig({ id: "obsidian-memory", name: "Obsidian memory", transport: "stdio",
  command: electron, args: [script, vault], env: { ELECTRON_RUN_AS_NODE: "1" } });

try {
  const registered = await bridge.reconcile(server);
  if (registered.state !== "configured") throw new Error(`Registration: ${registered.state}`);
  const configPath = join(home, ".gemini", "config", "mcp_config.json");
  const config = JSON.parse(await readFile(configPath, "utf8")) as { mcpServers?: Record<string, unknown> };
  if (!config.mcpServers?.["ai-workbench-obsidian-memory"]) throw new Error("The CLI did not write the isolated entry.");
  const cleanedEnv = Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
  const listed = await execCli({ executablePath: tool.path, args: ["mcp", "list"], env: cleanedEnv, timeoutMs: 8_000 });
  if (listed.exit.code !== 0 || !listed.stdout.includes("ai-workbench-obsidian-memory")) {
    throw new Error("Antigravity did not list the isolated memory server.");
  }
  await bridge.reconcile(null);
  const after = JSON.parse(await readFile(configPath, "utf8")) as { mcpServers?: Record<string, unknown> };
  if (after.mcpServers?.["ai-workbench-obsidian-memory"]) throw new Error("The CLI did not remove the isolated entry.");
  console.log("PASS: Antigravity CLI accepts and removes the shared memory MCP server in an isolated home; no model request was made.");
} finally {
  const resolvedHome = await realpath(home);
  const resolvedTemp = await realpath(tmpdir());
  const part = relative(resolvedTemp, resolvedHome);
  if (part && !part.startsWith("..") && !part.includes(sep) && basename(resolvedHome).startsWith("ai-workbench-agy-check-")) {
    await rm(resolvedHome, { recursive: true, force: true });
  }
}
