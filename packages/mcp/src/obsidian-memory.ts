import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { basename, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

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

function stringArg(args: Record<string, unknown>, key: string, max: number): string {
  const value = args[key];
  if (typeof value !== "string" || value.trim().length === 0 || value.length > max) {
    throw new Error(`${key} must be text of at most ${max} characters.`);
  }
  return value.trim();
}

function titleOf(content: string, path: string): string {
  const heading = /^#\s+([^\r\n]+)/m.exec(content)?.[1];
  return (heading ?? basename(path, ".md")).replace(/\s+/g, " ").trim().slice(0, 120);
}

/** Returns short matches; agents only read a full note when they choose it. */
export async function searchMemory(root: string, query: string, limit = 10): Promise<Array<{
  path: string; title: string; snippet: string;
}>> {
  const needle = query.trim().toLowerCase();
  if (needle.length < 2 || needle.length > 160) throw new Error("Search for 2 to 160 characters.");
  if (!Number.isInteger(limit) || limit < 1 || limit > 20) throw new Error("limit must be between 1 and 20.");
  const matches: Array<{ path: string; title: string; snippet: string; score: number }> = [];
  for (const path of await notes(root)) {
    let content: string;
    try {
      content = await readFile(await notePath(root, path), "utf8");
    } catch {
      continue;
    }
    const title = titleOf(content, path);
    const where = content.toLowerCase().indexOf(needle);
    const titleHit = title.toLowerCase().includes(needle);
    if (where < 0 && !titleHit) continue;
    const start = Math.max(0, where < 0 ? 0 : where - 60);
    const snippet = content.slice(start, start + 180).replace(/\s+/g, " ").trim();
    matches.push({ path, title, snippet, score: titleHit ? 2 : 1 });
  }
  return matches.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
    .slice(0, limit)
    .map(({ path, title, snippet }) => ({ path, title, snippet }));
}

export async function readMemory(root: string, path: string, offset = 0): Promise<{
  path: string; content: string; totalChars: number; nextOffset: number | null;
}> {
  if (!Number.isInteger(offset) || offset < 0) throw new Error("offset must be a nonnegative integer.");
  const content = await readFile(await notePath(root, path), "utf8");
  const end = Math.min(content.length, offset + 12_000);
  return { path, content: content.slice(offset, end), totalChars: content.length, nextOffset: end < content.length ? end : null };
}

/** Add a new note without touching existing notes, including ones edited in Obsidian. */
export async function addMemory(root: string, title: string, content: string): Promise<{ path: string; sha256: string }> {
  const cleanTitle = title.replace(/\s+/g, " ").trim();
  if (!cleanTitle || cleanTitle.length > 120 || content.length > 12_000 || !content.trim()) {
    throw new Error("A title and note of at most 12,000 characters are required.");
  }
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
  const text = `# ${cleanTitle}\n\n${content.trim()}\n`;
  await writeFile(join(folder, filename), text, { encoding: "utf8", flag: "wx" });
  return { path, sha256: createHash("sha256").update(text).digest("hex") };
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
].join(" ");

/** A tool-neutral MCP server. Every MCP-capable agent gets the same vault. */
export function createObsidianMemoryServer(root: string): Server {
  const server = new Server(
    { name: "ai-workbench-memory", version: "0.0.7" },
    { capabilities: { tools: {} }, instructions: OBSIDIAN_MEMORY_INSTRUCTIONS },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [
    { name: "memory_search", description: "Search the shared long-term memory (an Obsidian vault) before non-trivial work: earlier decisions, project conventions, known problems and the person's preferences. Returns short excerpts; read a note only when an excerpt is not enough.", inputSchema: { type: "object" as const, properties: { query: { type: "string" }, limit: { type: "integer", minimum: 1, maximum: 20 } }, required: ["query"] } },
    { name: "memory_read", description: "Read up to 12,000 characters from one note of the shared memory by relative path; use offset for the next part.", inputSchema: { type: "object" as const, properties: { path: { type: "string" }, offset: { type: "integer", minimum: 0 } }, required: ["path"] } },
    { name: "memory_add", description: "Save something the next agent should know: a decision and its reason, a project convention, the fix for a problem that could return, hard-won setup steps, a preference the person stated. One short note per topic; never secrets or transient progress. Adds a new note and never replaces one.", inputSchema: { type: "object" as const, properties: { title: { type: "string" }, content: { type: "string" } }, required: ["title", "content"] } },
  ] }));
  server.setRequestHandler(CallToolRequestSchema, async (request): Promise<ToolReply> => {
    const args = request.params.arguments ?? {};
    try {
      switch (request.params.name) {
        case "memory_search": return reply(await searchMemory(root, stringArg(args, "query", 160), Number(args["limit"] ?? 10)));
        case "memory_read": return reply(await readMemory(root, stringArg(args, "path", 500), Number(args["offset"] ?? 0)));
        case "memory_add": return reply(await addMemory(root, stringArg(args, "title", 120), stringArg(args, "content", 12_000)));
        default: return { ...reply({ error: "Unknown memory tool" }), isError: true };
      }
    } catch (error) {
      return { ...reply({ error: error instanceof Error ? error.message : String(error) }), isError: true };
    }
  });
  return server;
}

export async function serveObsidianMemory(path: string): Promise<void> {
  const root = await openMemoryVault(path);
  await createObsidianMemoryServer(root).connect(new StdioServerTransport());
}
