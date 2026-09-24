import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { makeTempDirectory, removeTempDirectory } from "@ai-workbench/test-support";
import { readJsonMcpServers, runnable } from "../mcp-configs.js";
import { findSkillsDeep } from "../skills.js";

describe("MCP servers in the shared JSON format", () => {
  it("reads stdio and remote servers and leaves out what cannot run", () => {
    const servers = readJsonMcpServers(
      {
        creator: { type: "stdio", command: "bun", args: ["run", "index.ts"], env: { MODE: "dev" } },
        stitch: { type: "http", url: "https://example.com/mcp", headers: { "X-Goog-Api-Key": "k" } },
        broken: { type: "stdio", command: "\\", args: [] },
        off: { command: "node", disabled: true },
        nonsense: "not a server",
      },
      "Claude Code · your servers",
    );
    expect(servers.map((server) => server.name)).toEqual(["creator", "stitch"]);
    expect(servers[0]).toMatchObject({ transport: "stdio", command: "bun", args: ["run", "index.ts"], env: { MODE: "dev" } });
    expect(servers[1]).toMatchObject({ transport: "http", url: "https://example.com/mcp", headers: { "X-Goog-Api-Key": "k" } });
  });

  it("knows a command that could run from one that cannot", () => {
    expect(runnable("cmd.exe")).toBe(true);
    expect(runnable("\\")).toBe(false);
    expect(runnable("./")).toBe(false);
    expect(runnable("")).toBe(false);
  });
});

describe("skills nested at any depth", () => {
  let directory = "";
  afterEach(async () => {
    if (directory) await removeTempDirectory(directory);
  });

  async function skill(path: string, name: string, description: string): Promise<void> {
    await mkdir(path, { recursive: true });
    await writeFile(join(path, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\n---\n\nBody\n`);
  }

  it("finds every skill once, however deep, and skips tool internals", async () => {
    directory = await makeTempDirectory("ai-workbench-skills-deep-");
    await skill(join(directory, "marketplaces", "fallow-skills", "fallow", "skills", "fallow"), "fallow", "Code health");
    // The same plugin skill again in the tool's cache: listed once.
    await skill(join(directory, "cache", "fallow-skills", "fallow", "1.0.0", "skills", "fallow"), "fallow", "Code health");
    await skill(join(directory, "synced", "org", "plugin", "skills", "review"), "review", "Reviews");
    await skill(join(directory, "node_modules", "pkg", "skills", "hidden"), "hidden", "Never offered");
    await skill(join(directory, ".git", "skills", "hidden2"), "hidden2", "Never offered");

    const found = await findSkillsDeep(directory, () => "test");
    expect(found.map((entry) => entry.name).sort()).toEqual(["fallow", "review"]);
  });
});
