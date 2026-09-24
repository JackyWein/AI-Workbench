import { join } from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { makeTempDirectory, removeTempDirectory } from "@ai-workbench/test-support";
import { parseMcpServerConfig } from "@ai-workbench/shared";
import { AntigravityMemoryBridge } from "../antigravity-memory.js";

describe("Antigravity shared memory registration", () => {
  let home: string;
  afterEach(async () => { if (home) await removeTempDirectory(home); });

  it("owns only its marked global entry and preserves unrelated servers", async () => {
    home = await makeTempDirectory("ai-workbench-agy-memory-");
    const configPath = join(home, ".gemini", "config", "mcp_config.json");
    await mkdir(join(home, ".gemini", "config"), { recursive: true });
    await writeFile(configPath, JSON.stringify({ mcpServers: { personal: { command: "personal-tool" } } }));
    const server = parseMcpServerConfig({
      id: "obsidian-memory", name: "Obsidian memory", transport: "stdio",
      command: process.execPath, args: ["memory-server.js", home],
      env: { ELECTRON_RUN_AS_NODE: "1" },
    });
    const bridge = new AntigravityMemoryBridge({
      home, executablePath: process.execPath, expectedCommand: process.execPath,
      expectedScript: "memory-server.js",
      run: async (_executable, args) => {
        const config = JSON.parse(await readFile(configPath, "utf8")) as { mcpServers: Record<string, unknown> };
        if (args[1] === "add") {
          const nameIndex = args.indexOf("ai-workbench-obsidian-memory");
          config.mcpServers["ai-workbench-obsidian-memory"] = {
            command: args[nameIndex + 1], args: args.slice(nameIndex + 2),
            env: { AI_WORKBENCH_OBSIDIAN_MEMORY: "1", ELECTRON_RUN_AS_NODE: "1" },
          };
        } else if (args[1] === "remove") {
          delete config.mcpServers["ai-workbench-obsidian-memory"];
        }
        await writeFile(configPath, JSON.stringify(config));
        return { code: 0, stdout: "" };
      },
    });
    expect((await bridge.reconcile(server)).state).toBe("configured");
    expect((await bridge.status(server)).state).toBe("configured");
    expect((await bridge.reconcile(null)).state).toBe("not-configured");
    const after = JSON.parse(await readFile(configPath, "utf8")) as { mcpServers: Record<string, unknown> };
    expect(after.mcpServers["personal"]).toEqual({ command: "personal-tool" });
    expect(after.mcpServers["ai-workbench-obsidian-memory"]).toBeUndefined();
  });

  it("refuses to overwrite an unmarked Antigravity entry", async () => {
    home = await makeTempDirectory("ai-workbench-agy-collision-");
    const configPath = join(home, ".gemini", "config", "mcp_config.json");
    await mkdir(join(home, ".gemini", "config"), { recursive: true });
    await writeFile(configPath, JSON.stringify({ mcpServers: { "ai-workbench-obsidian-memory": { command: "someone-else" } } }));
    const bridge = new AntigravityMemoryBridge({ home, executablePath: process.execPath,
      run: async () => { throw new Error("Must not run the CLI"); } });
    const server = parseMcpServerConfig({ id: "obsidian-memory", name: "Memory", command: process.execPath,
      args: ["memory-server.js", home], env: { ELECTRON_RUN_AS_NODE: "1" } });
    expect((await bridge.reconcile(server)).state).toBe("conflict");
  });
});
