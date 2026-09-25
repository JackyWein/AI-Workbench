import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, readdir, realpath, rename, unlink, writeFile } from "node:fs/promises";
import { basename, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { scanText } from "@ai-workbench/shared";
import { z } from "zod";
import { indexedMemorySearch, type IndexedMemoryNote, type MemorySearchHit } from "./memory-index.js";

const MAX_FILES = 5_000;
const MAX_NOTE_BYTES = 1_000_000;
const MAX_INSPECT_FILES = 20_000;
const MAX_GRAPH_NOTES = 180;
const MAX_GRAPH_EDGES = 500;
const MEMORY_FOLDER = "AI Workbench Memory";

type ToolReply = { content: Array<{ type: "text"; text: string }>; isError?: boolean };
const reply = (value: unknown): ToolReply => ({ content: [{ type: "text", text: JSON.stringify(value) }] });

/** The vault is a normal Markdown folder. Obsidian can edit it while this runs. */
export async function openMemoryVault(path: string): Promise<string> {
  const root = await realpath(path);
  if (!(await lstat(root)).isDirectory()) throw new Error("The memory vault is not a folder.");
  return root;
}

function inside(root: string, path: string): boolean {
  const part = relative(root, path);
  return part === "" || (!isAbsolute(part) && part !== ".." && !part.startsWith(`..${sep}`));
}

/** Only Markdown files visible in the vault; never .obsidian or symlinks. */
async function notes(root: string): Promise<string[]> {
  const found: string[] = [];
  const pending = [root];
  while (pending.length > 0 && found.length < MAX_FILES) {
    const directory = pending.pop() as string;
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith(".") || entry.isSymbolicLink()) continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) pending.push(path);
      else if (entry.isFile() && extname(entry.name).toLowerCase() === ".md") {
        found.push(relative(root, path).replaceAll("\\", "/"));
      }
      if (found.length >= MAX_FILES) break;
    }
  }
  return found;
}

export interface MemoryVaultSnapshot {
  readonly path: string;
  readonly totalBytes: number;
  readonly noteBytes: number;
  readonly otherBytes: number;
  readonly noteCount: number;
  readonly otherCount: number;
  readonly truncated: boolean;
  readonly graphTruncated: boolean;
  readonly nodes: Array<{ path: string; title: string; bytes: number }>;
  readonly edges: Array<{ from: string; to: string }>;
}

/** Local, bounded vault overview for the visual Obsidian page. */
export async function inspectMemoryVault(root: string): Promise<MemoryVaultSnapshot> {
  const vault = await openMemoryVault(root);
  const pending = [vault];
  const markdown: Array<{ path: string; bytes: number }> = [];
  let noteBytes = 0;
  let otherBytes = 0;
  let otherCount = 0;
  let scanned = 0;
  while (pending.length > 0 && scanned < MAX_INSPECT_FILES) {
    const directory = pending.pop() as string;
    let entries;
    try { entries = await readdir(directory, { withFileTypes: true }); }
    catch { continue; }
    for (const entry of entries) {
      if (entry.name.startsWith(".") || entry.isSymbolicLink()) continue;
      const full = join(directory, entry.name);
      if (entry.isDirectory()) { pending.push(full); continue; }
      if (!entry.isFile()) continue;
      let size: number;
      try { size = (await lstat(full)).size; } catch { continue; }
      scanned++;
      if (extname(entry.name).toLowerCase() === ".md") {
        markdown.push({ path: relative(vault, full).replaceAll("\\", "/"), bytes: size });
        noteBytes += size;
      } else {
        otherBytes += size;
        otherCount++;
      }
      if (scanned >= MAX_INSPECT_FILES) break;
    }
  }
  markdown.sort((a, b) => a.path.localeCompare(b.path));
  const selected = markdown.slice(0, MAX_GRAPH_NOTES);
  const selectedPaths = new Set(selected.map((note) => note.path.toLowerCase()));
  const byStem = new Map<string, string[]>();
  for (const note of selected) {
    const stem = basename(note.path, ".md").toLowerCase();
    byStem.set(stem, [...(byStem.get(stem) ?? []), note.path]);
  }
  const nodes: MemoryVaultSnapshot["nodes"] = [];
  const edges: MemoryVaultSnapshot["edges"] = [];
  const seenEdges = new Set<string>();
  for (const note of selected) {
    let content = "";
    if (note.bytes <= MAX_NOTE_BYTES) {
      try { content = await readFile(await notePath(vault, note.path), "utf8"); }
      catch { /* A note can disappear while Obsidian edits the vault. */ }
    }
    nodes.push({ path: note.path, title: titleOf(content, note.path), bytes: note.bytes });
    for (const match of content.matchAll(/\[\[([^\]\n]+)\]\]/g)) {
      const target = match[1]?.split("|")[0]?.split("#")[0]?.trim();
      if (!target) continue;
      const exact = `${target.replaceAll("\\", "/").replace(/\.md$/i, "")}.md`.toLowerCase();
      const resolved = selectedPaths.has(exact) ? selected.find((item) => item.path.toLowerCase() === exact)?.path
        : byStem.get(basename(exact, ".md"))?.length === 1 ? byStem.get(basename(exact, ".md"))?.[0] : undefined;
      if (!resolved || resolved === note.path) continue;
      const key = `${note.path}\0${resolved}`;
      if (!seenEdges.has(key) && edges.length < MAX_GRAPH_EDGES) {
        seenEdges.add(key);
        edges.push({ from: note.path, to: resolved });
      }
    }
  }
  return {
    path: vault, totalBytes: noteBytes + otherBytes, noteBytes, otherBytes,
    noteCount: markdown.length, otherCount,
    truncated: pending.length > 0 || scanned >= MAX_INSPECT_FILES,
    graphTruncated: markdown.length > selected.length || edges.length >= MAX_GRAPH_EDGES,
    nodes, edges,
  };
}

async function notePath(root: string, value: unknown): Promise<string> {
  if (typeof value !== "string" || value.length < 1 || value.length > 500 || value.includes("\\") || value.includes("\0")) {
    throw new Error("A relative Markdown path is required.");
  }
  const parts = value.split("/");
  if (parts.some((part) => !part || part === "." || part === ".." || part.startsWith(".") || part.includes(":")) ||
    extname(value).toLowerCase() !== ".md") {
    throw new Error("Only Markdown notes inside the vault can be read.");
  }
  const candidate = resolve(root, ...parts);
  if (!inside(root, candidate)) throw new Error("The note is outside the vault.");
  const stat = await lstat(candidate);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_NOTE_BYTES) {
    throw new Error("The note is not a readable Markdown file.");
  }
  if (!inside(root, await realpath(candidate))) throw new Error("The note is outside the vault.");
  return candidate;
}

function titleOf(content: string, path: string): string {
  const heading = /^#\s+([^\r\n]+)/m.exec(content)?.[1];
  return (heading ?? basename(path, ".md")).replace(/\s+/g, " ").trim().slice(0, 120);
}

/** Returns short matches; agents only read a full note when they choose it. */
export async function searchMemory(root: string, query: string, limit = 10): Promise<MemorySearchHit[]> {
  const needle = query.trim().toLowerCase();
  if (needle.length < 2 || needle.length > 160) throw new Error("Search for 2 to 160 characters.");
  if (!Number.isInteger(limit) || limit < 1 || limit > 20) throw new Error("limit must be between 1 and 20.");
  return indexedMemorySearch(await openMemoryVault(root), query, limit, () => loadIndexNotes(root));
}

async function* loadIndexNotes(root: string): AsyncIterable<IndexedMemoryNote> {
  for (const path of await notes(root)) {
    try {
      const note = await fullNote(root, path);
      // Never copy a credential from an externally edited note into the cache.
      if (scanText(note.content).length) continue;
      yield { path, title: titleOf(note.content, path), content: note.content, version: note.version };
    } catch { /* An editor may move or replace a note during the scan. */ }
  }
}

export async function rebuildMemoryIndex(root: string): Promise<void> {
  await indexedMemorySearch(await openMemoryVault(root), null, 0, () => loadIndexNotes(root));
}

async function fullNote(root: string, path: string): Promise<{ content: string; version: string; sha256: string }> {
  const file = await notePath(root, path);
  const before = await lstat(file, { bigint: true });
  const content = await readFile(file, "utf8");
  const after = await lstat(file, { bigint: true });
  if (before.mtimeNs !== after.mtimeNs || before.size !== after.size || before.ino !== after.ino) {
    throw new Error("The note changed while it was read. Read it again before editing.");
  }
  const sha256 = createHash("sha256").update(content).digest("hex");
  return { content, sha256, version: `${after.mtimeNs}:${after.size}:${sha256}` };
}

export async function readMemory(root: string, path: string, offset = 0): Promise<{
  path: string; content: string; totalChars: number; nextOffset: number | null; version: string; sha256: string;
}> {
  if (!Number.isInteger(offset) || offset < 0) throw new Error("offset must be a nonnegative integer.");
  const { content, version, sha256 } = await fullNote(root, path);
  const end = Math.min(content.length, offset + 12_000);
  return { path, content: content.slice(offset, end), totalChars: content.length, nextOffset: end < content.length ? end : null, version, sha256 };
}

/** Add a new note without touching existing notes, including ones edited in Obsidian. */
export async function addMemory(root: string, title: string, content: string): Promise<MemorySaveResult> {
  root = await openMemoryVault(root);
  const cleanTitle = title.replace(/\s+/g, " ").trim();
  if (!cleanTitle || cleanTitle.length > 120 || content.length > 12_000 || !content.trim()) {
    throw new Error("A title and note of at most 12,000 characters are required.");
  }
  assertNoSecret(`${cleanTitle}\n${content}`);
  const related = await relatedNotes(root, cleanTitle, content);
  const folder = join(root, MEMORY_FOLDER);
  try {
    const stat = await lstat(folder);
    if (!stat.isDirectory() || stat.isSymbolicLink() || !inside(root, await realpath(folder))) {
      throw new Error("The memory folder is not a normal vault folder.");
    }
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      await mkdir(folder);
    } else {
      throw error;
    }
  }
  const slug = cleanTitle.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48) || "note";
  const filename = `${new Date().toISOString().slice(0, 10)}-${slug}-${randomUUID().slice(0, 8)}.md`;
  const path = `${MEMORY_FOLDER}/${filename}`;
  const text = withLinks(`# ${cleanTitle}\n\n${content.trim()}\n`, related);
  await writeFile(join(folder, filename), text, { encoding: "utf8", flag: "wx" });
  const saved = await fullNote(root, path);
  return { path, sha256: saved.sha256, version: saved.version, related };
}

export interface MemorySaveResult { path: string; sha256: string; version: string; related: MemorySearchHit[] }

function assertNoSecret(content: string): void {
  const found = scanText(content);
  if (found.length) throw new Error(`Note refused: likely ${found[0]?.kind.toLowerCase() ?? "secret"}. Remove the secret before saving.`);
}

async function relatedNotes(root: string, title: string, content: string, exclude?: string): Promise<MemorySearchHit[]> {
  const topic = title.length >= 2 ? title : content.slice(0, 160);
  return (await searchMemory(root, topic.slice(0, 160), 4)).filter((hit) => hit.path !== exclude).slice(0, 3);
}

function withLinks(content: string, related: MemorySearchHit[]): string {
  const links = related.filter((note) => !content.includes(`[[${note.path.replace(/\.md$/i, "")}`));
  if (!links.length) return content;
  return `${content.trimEnd()}\n\nRelated: ${links.map((note) => `[[${note.path.replace(/\.md$/i, "")}]]`).join(" · ")}\n`;
}

/** Refuses stale revisions across agent processes; a temporary file makes replacement atomic. */
export async function updateMemory(root: string, path: string, content: string, expectedVersion: string, append = false): Promise<MemorySaveResult> {
  root = await openMemoryVault(root);
  if (!content.trim() || content.length > 12_000 || !expectedVersion) throw new Error("Read the note first and provide its version and up to 12,000 characters.");
  assertNoSecret(content);
  const file = await notePath(root, path);
  const lock = `${file}.workbench-lock`;
  try { await writeFile(lock, "Memory update in progress", { flag: "wx" }); }
  catch { throw new Error("The note is being edited. Read it again and retry after the other update finishes."); }
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    const original = await fullNote(root, path);
    if (original.version !== expectedVersion) throw new Error("The note changed since it was read. Read it again and merge your changes.");
    let next = append ? `${original.content.trimEnd()}\n\n${content.trim()}\n` : `${content.trim()}\n`;
    assertNoSecret(next);
    if (Buffer.byteLength(next) > MAX_NOTE_BYTES) throw new Error("The combined note exceeds 1 MB.");
    const related = await relatedNotes(root, titleOf(next, path), next, path);
    next = withLinks(next, related);
    await writeFile(temporary, next, { flag: "wx" });
    if ((await fullNote(root, path)).version !== expectedVersion) throw new Error("The note changed since it was read. Read it again and merge your changes.");
    await rename(temporary, file);
    const saved = await fullNote(root, path);
    return { path, version: saved.version, sha256: saved.sha256, related };
  } finally {
    await unlink(temporary).catch(() => undefined);
    await unlink(lock);
  }
}

/** A scoped server receives only this root, never a caller-selected workspace id. */
export async function openWorkspaceMemory(workspacePath: string): Promise<string> {
  let root = await openMemoryVault(workspacePath);
  for (const folder of [".workbench", "memory"]) {
    const next = join(root, folder);
    await mkdir(next, { recursive: true });
    if ((await lstat(next)).isSymbolicLink() || !inside(root, await realpath(next))) throw new Error("Workspace memory must stay inside the workspace.");
    root = await realpath(next);
  }
  return root;
}

/**
 * When an agent should reach for the memory, sent as the server's own MCP
 * instructions. A memory that is only there when someone says "look it up"
 * or "write that down" does not remember anything: these tell every agent,
 * whatever tool it runs in, to read before it starts and to write what the
 * next agent would otherwise have to find out again.
 */
export const OBSIDIAN_MEMORY_INSTRUCTIONS = [
  "This is the shared long-term memory of every agent working with this person, across tools, sessions and teams.",
  "Before non-trivial work, call memory_search with the project, component or topic to find earlier decisions, conventions, known problems and preferences; read a matching note with memory_read only when an excerpt is not enough.",
  "When you learn something durable, call memory_add once with a short note: a decision and why it was made, a convention of the project, the fix for a problem that could come back, setup or build steps that were hard to find, a preference the person stated.",
  "Do not store secrets, credentials, personal data, whole files or transient progress. One topic per note, a title that says what it is about.",
  "Use memory_update or memory_append to improve an existing note: first memory_read, then pass its exact version. On a conflict, read again and merge. Saved notes suggest related wiki links.",
].join(" ");

/** A tool-neutral MCP server. Every MCP-capable agent gets the same vault. */
export function createObsidianMemoryServer(root: string): McpServer {
  const server = new McpServer(
    { name: "ai-workbench-memory", version: "0.0.7" },
    { capabilities: { tools: {} }, instructions: OBSIDIAN_MEMORY_INSTRUCTIONS },
  );
  const respond = async (action: () => Promise<unknown>): Promise<ToolReply> => {
    try {
      return reply(await action());
    } catch (error) {
      return { ...reply({ error: error instanceof Error ? error.message : String(error) }), isError: true };
    }
  };
  const readAnnotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
  const writeAnnotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
  const pathSchema = z.string().min(1).max(500).describe("Relative Markdown path returned by memory_search or memory_add.");
  server.registerTool("memory_search", {
    title: "Search memory", description: "Search before non-trivial work. Returns up to 20 ranked note names and short excerpts from a rebuildable local index.",
    inputSchema: z.object({ query: z.string().trim().min(2).max(160), limit: z.number().int().min(1).max(20).default(10) }).strict(), annotations: readAnnotations,
  }, ({ query, limit }) => respond(() => searchMemory(root, query, limit)));
  server.registerTool("memory_read", {
    title: "Read memory", description: "Read up to 12,000 characters and its version. Use offset for more; retain version for memory_update or memory_append.",
    inputSchema: z.object({ path: pathSchema, offset: z.number().int().nonnegative().default(0) }).strict(), annotations: readAnnotations,
  }, ({ path, offset }) => respond(() => readMemory(root, path, offset)));
  server.registerTool("memory_add", {
    title: "Add memory", description: "Save a short durable decision or project convention. Refuses likely secrets; returns the new path, version and related notes, also linked in the saved note.",
    inputSchema: z.object({ title: z.string().trim().min(1).max(120), content: z.string().trim().min(1).max(12_000) }).strict(), annotations: writeAnnotations,
  }, ({ title, content }) => respond(() => addMemory(root, title, content)));
  for (const name of ["memory_update", "memory_append"] as const) {
    server.registerTool(name, {
      title: name === "memory_update" ? "Update memory" : "Append to memory",
      description: `${name === "memory_update" ? "Replace the full Markdown content of" : "Append Markdown to"} an existing note. Requires its version from memory_read; changed notes are refused. Read again and merge after a conflict. Likely secrets are refused.`,
      inputSchema: z.object({ path: pathSchema, content: z.string().trim().min(1).max(12_000), version: z.string().min(1).max(200).describe("Exact version returned by the most recent memory_read.") }).strict(),
      annotations: { ...writeAnnotations, destructiveHint: name === "memory_update" },
    }, ({ path, content, version }) => respond(() => updateMemory(root, path, content, version, name === "memory_append")));
  }
  return server;
}

export async function serveObsidianMemory(path: string): Promise<void> {
  const root = await openMemoryVault(path);
  await createObsidianMemoryServer(root).connect(new StdioServerTransport());
}
