import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import electron from "electron";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const root = fileURLToPath(new URL("..", import.meta.url));
const packaged = process.argv.includes("--packaged");
if (packaged && process.platform !== "win32") {
  throw new Error("The packaged memory check currently targets the Windows directory build.");
}
const executable = packaged ? resolve(root, "release/win-unpacked/ai-workbench.exe") : electron;
const entry = packaged
  ? resolve(root, "release/win-unpacked/resources/app.asar/out/main/memory-server.js")
  : resolve(root, "apps/desktop/out/main/memory-server.js");
const vault = await mkdtemp(join(tmpdir(), "ai-workbench-memory-check-"));
const client = new Client({ name: "memory-check", version: "1" }, { capabilities: {} });

try {
  await writeFile(join(vault, "Existing.md"), "# Existing\n\nShared note for the team.\n");
  const transport = new StdioClientTransport({
    command: executable,
    args: [entry, vault],
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    stderr: "pipe",
  });
  await client.connect(transport);
  assert.deepEqual((await client.listTools()).tools.map((tool) => tool.name), [
    "memory_search", "memory_read", "memory_add", "memory_update", "memory_append",
  ]);
  const search = await client.callTool({ name: "memory_search", arguments: { query: "Shared note" } });
  assert.equal(search.isError, undefined);
  assert.match(JSON.stringify(search.content), /Existing\.md/);
  const add = await client.callTool({ name: "memory_add", arguments: { title: "Team decision", content: "Keep notes concise." } });
  assert.equal(add.isError, undefined);
  const note = JSON.parse(add.content[0].text);
  assert.match(await readFile(join(vault, ...note.path.split("/")), "utf8"), /Keep notes concise/);
  const read = await client.callTool({ name: "memory_read", arguments: { path: note.path } });
  assert.match(JSON.stringify(read.content), /Team decision/);
  process.stdout.write(`PASS: ${packaged ? "packaged" : "bundled"} Obsidian memory server serves search, read and add through Electron Node mode.\n`);
} finally {
  await client.close();
  await rm(vault, { recursive: true, force: true });
}
