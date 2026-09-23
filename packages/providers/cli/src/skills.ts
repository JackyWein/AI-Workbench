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
