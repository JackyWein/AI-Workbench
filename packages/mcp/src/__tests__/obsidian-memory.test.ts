import { join } from "node:path";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { makeTempDirectory, removeTempDirectory } from "@ai-workbench/test-support";
import { addMemory, createObsidianMemoryServer, inspectMemoryVault, openMemoryVault, readMemory, searchMemory } from "../obsidian-memory.js";

describe("shared Obsidian Markdown memory", () => {
  let directory: string;
  afterEach(async () => {
    if (directory) await removeTempDirectory(directory);
  });

  it("searches briefly, reads on demand, and adds without replacing existing notes", async () => {
    directory = await makeTempDirectory("ai-workbench-vault-");
    const root = await openMemoryVault(directory);
    await writeFile(join(root, "Project.md"), "# Project plan\n\nKeep the weekly review short.\n");
    await mkdir(join(root, ".obsidian"));
    await writeFile(join(root, ".obsidian", "private.md"), "secret phrase\n");

    expect(await searchMemory(root, "weekly")).toEqual([
      { path: "Project.md", title: "Project plan", snippet: "# Project plan Keep the weekly review short." },
    ]);
    expect(await searchMemory(root, "secret")).toEqual([]);
    expect((await readMemory(root, "Project.md")).content).toContain("weekly review");
    await expect(readMemory(root, "../Project.md")).rejects.toThrow();
    await expect(readMemory(root, ".obsidian/private.md")).rejects.toThrow();

    const added = await addMemory(root, "Shared decision", "The next review is on Friday.");
    expect(added.path).toMatch(/^AI Workbench Memory\/\d{4}-\d\d-\d\d-shared-decision-/);
    expect((await readMemory(root, added.path)).content).toContain("Friday");
    expect((await readMemory(root, "Project.md")).content).toContain("weekly review");
  });

  it("offers the same search, read and add tools over MCP", async () => {
    directory = await makeTempDirectory("ai-workbench-vault-mcp-");
    const root = await openMemoryVault(directory);
    const server = createObsidianMemoryServer(root);
    const client = new Client({ name: "check", version: "1" }, { capabilities: {} });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual([
        "memory_search", "memory_read", "memory_add",
      ]);
      const added = await client.callTool({ name: "memory_add", arguments: { title: "Team memory", content: "Remember the project boundary." } });
      expect(added.isError).not.toBe(true);
      const found = await client.callTool({ name: "memory_search", arguments: { query: "boundary" } });
      expect(JSON.stringify(found.content)).toContain("Team memory");
      const rejected = await client.callTool({ name: "memory_read", arguments: { path: "../outside.md" } });
      expect(rejected.isError).toBe(true);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("refuses symlinked notes outside the vault", async () => {
    directory = await makeTempDirectory("ai-workbench-vault-link-");
    const root = await openMemoryVault(directory);
    const outside = await makeTempDirectory("ai-workbench-outside-");
    try {
      await writeFile(join(outside, "outside.md"), "outside");
      try {
        await symlink(join(outside, "outside.md"), join(root, "linked.md"), "file");
      } catch {
        // Some Windows accounts may not be allowed to create symlinks.
        return;
      }
      expect(await searchMemory(root, "outside")).toEqual([]);
      await expect(readMemory(root, "linked.md")).rejects.toThrow();
    } finally {
      await removeTempDirectory(outside);
    }
  });

  it("counts local storage and draws only actual wiki links", async () => {
    directory = await makeTempDirectory("ai-workbench-vault-graph-");
    await writeFile(join(directory, "Alpha.md"), "# Alpha\n\nSee [[Beta]] and [[Missing]].\n");
    await writeFile(join(directory, "Beta.md"), "# Beta\n\nDetails.\n");
    await writeFile(join(directory, "diagram.png"), "image bytes");
    await mkdir(join(directory, ".obsidian"));
    await writeFile(join(directory, ".obsidian", "private.md"), "hidden");
    const snapshot = await inspectMemoryVault(directory);
    expect(snapshot.noteCount).toBe(2);
    expect(snapshot.otherCount).toBe(1);
    expect(snapshot.totalBytes).toBe(snapshot.noteBytes + snapshot.otherBytes);
    expect(snapshot.edges).toEqual([{ from: "Alpha.md", to: "Beta.md" }]);
    expect(snapshot.nodes.map((node) => node.title)).toEqual(["Alpha", "Beta"]);
  });
});
