import { createClient, type Client, type InStatement } from "@libsql/client";
import { lstat, mkdir, realpath } from "node:fs/promises";
import { join } from "node:path";

export interface IndexedMemoryNote { path: string; title: string; content: string; version: string }
export interface MemorySearchHit { path: string; title: string; snippet: string }
const CACHE_DIRECTORY = ".ai-workbench-memory";

/** The database is disposable. Markdown files are always authoritative. */
async function openIndex(root: string): Promise<Client> {
  const folder = join(root, CACHE_DIRECTORY);
  await mkdir(folder, { recursive: true });
  if ((await lstat(folder)).isSymbolicLink() || await realpath(folder) !== folder) {
    throw new Error("The memory index must be a normal folder inside the vault.");
  }
  const file = join(folder, "search.sqlite");
  const info = await lstat(file).catch(() => null);
  if (info && (!info.isFile() || info.isSymbolicLink())) throw new Error("The memory index is not a normal file.");
  const client = createClient({ url: `file:${file}` });
  try {
    await client.execute("PRAGMA busy_timeout = 5000");
    await client.execute("CREATE VIRTUAL TABLE IF NOT EXISTS notes USING fts5(path UNINDEXED, title, content, version UNINDEXED, tokenize='unicode61 remove_diacritics 2')");
    return client;
  } catch (error) { client.close(); throw error; }
}

/** Refreshes changed files and removes deleted ones, then ranks with SQLite BM25. */
export async function indexedMemorySearch(
  root: string,
  query: string | null,
  limit: number,
  load: () => AsyncIterable<IndexedMemoryNote>,
): Promise<MemorySearchHit[]> {
  const client = await openIndex(root);
  try {
    const previous = await client.execute("SELECT path, version FROM notes");
    const known = new Map(previous.rows.map((row) => [String(row["path"]), String(row["version"])]));
    const changes: InStatement[] = [];
    for await (const note of load()) {
      if (known.get(note.path) !== note.version) {
        changes.push({ sql: "DELETE FROM notes WHERE path = ?", args: [note.path] });
        changes.push({ sql: "INSERT INTO notes(path, title, content, version) VALUES (?, ?, ?, ?)", args: [note.path, note.title, note.content, note.version] });
      }
      known.delete(note.path);
    }
    for (const path of known.keys()) changes.push({ sql: "DELETE FROM notes WHERE path = ?", args: [path] });
    if (changes.length) await client.batch(changes, "write");
    if (query === null) return [];
    // Quote tokens ourselves: user punctuation can never become FTS syntax.
    const terms = [...new Set(query.toLowerCase().match(/[\p{L}\p{N}]{2,}/gu) ?? [])].slice(0, 20);
    if (!terms.length) return [];
    const result = await client.execute({
      sql: "SELECT path, title, snippet(notes, 2, '', '', '…', 28) AS snippet FROM notes WHERE notes MATCH ? ORDER BY bm25(notes, 0, 6, 1, 0), path LIMIT ?",
      args: [terms.map((term) => '"' + term + '"*').join(" OR "), limit],
    });
    return result.rows.map((row) => ({ path: String(row["path"]), title: String(row["title"]), snippet: String(row["snippet"]).replace(/\s+/g, " ").trim().slice(0, 180) }));
  } finally { client.close(); }
}
