import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import type { ImportableSkill } from "@ai-workbench/provider-base";

/** A folder where a tool keeps skills, one sub-folder with a SKILL.md each. */
export interface SkillFolder {
  readonly path: string;
  /** Where it is, in words: "user skills", "this project". */
  readonly source: string;
}

/**
 * The skills in these folders, with the name and description from each
 * SKILL.md's front matter. A folder that is not there is simply empty;
 * folders starting with "." are the tool's own (Codex keeps its built-in
 * skills in `.system`).
 */
export async function findSkills(folders: readonly SkillFolder[]): Promise<ImportableSkill[]> {
  const found: ImportableSkill[] = [];
  for (const folder of folders) {
    const entries = await readdir(folder.path, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) {
        continue;
      }
      const path = join(folder.path, entry.name);
      const file = join(path, "SKILL.md");
      const info = await stat(file).catch(() => null);
      if (!info?.isFile() || info.size > 1024 * 1024) {
        continue;
      }
      const text = await readFile(file, "utf8").catch(() => "");
      const attributes = frontMatter(text);
      found.push({
        path,
        name: attributes["name"] ?? entry.name,
        description: attributes["description"] ?? "",
        source: folder.source,
      });
    }
  }
  return found;
}

function frontMatter(text: string): Record<string, string> {
  if (!text.startsWith("---")) {
    return {};
  }
  const end = text.indexOf("\n---", 3);
  const attributes: Record<string, string> = {};
  for (const line of (end === -1 ? "" : text.slice(3, end)).split("\n")) {
    const match = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line.trim());
    if (match?.[1]) {
      attributes[match[1]] = (match[2] ?? "").trim().replace(/^(["'])(.*)\1$/, "$2");
    }
  }
  return attributes;
}

/** Folders never worth walking into when looking for skills. */
const SKIPPED = new Set(["node_modules", ".git", ".venv", "dist", "out", "build", "__pycache__"]);

/**
 * Every skill below a folder, however deep the tool nests them — plugin
 * caches and synced organisation skills sit several levels down. The walk is
 * bounded in depth and in count, never follows a folder that starts with ".",
 * and a skill found twice (the same plugin in a marketplace and in its cache)
 * is kept once. `sourceOf` names where each one came from.
 */
export async function findSkillsDeep(
  root: string,
  sourceOf: (skillPath: string) => string,
  options: { readonly maxDepth?: number; readonly limit?: number } = {},
): Promise<ImportableSkill[]> {
  const maxDepth = options.maxDepth ?? 7;
  const limit = options.limit ?? 300;
  const found: ImportableSkill[] = [];
  const seen = new Set<string>();

  const walk = async (folder: string, depth: number): Promise<void> => {
    if (found.length >= limit || depth > maxDepth) {
      return;
    }
    const file = join(folder, "SKILL.md");
    const info = await stat(file).catch(() => null);
    if (info?.isFile() && info.size <= 1024 * 1024) {
      const text = await readFile(file, "utf8").catch(() => "");
      const attributes = frontMatter(text);
      const name = attributes["name"] ?? folder.split(/[\\/]/).pop() ?? "skill";
      const description = attributes["description"] ?? "";
      const key = `${name}\u0000${description}`;
      if (!seen.has(key)) {
        seen.add(key);
        found.push({ path: folder, name, description, source: sourceOf(folder) });
      }
      // A skill folder holds the skill's own files, not further skills.
      return;
    }
    const entries = await readdir(folder, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith(".") || SKIPPED.has(entry.name)) {
        continue;
      }
      await walk(join(folder, entry.name), depth + 1);
      if (found.length >= limit) {
        return;
      }
    }
  };

  await walk(root, 0);
  return found;
}
