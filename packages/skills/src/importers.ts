import { readFile, readdir, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import type { SkillManifestInput } from "@ai-workbench/shared";

/**
 * Importers turn an external skill format into the internal, provider-neutral
 * one (spec §31). Nothing downstream ever sees the original shape, so adding a
 * format is an importer, not a change to the skill model.
 */
export interface SkillImporter {
  readonly id: string;
  readonly displayName: string;
  /** Whether this importer recognizes the given directory or file. */
  canImport(path: string): Promise<boolean>;
  import(path: string): Promise<SkillManifestInput[]>;
}

/** Front matter used by Claude-style skills: a `---` delimited YAML header. */
export function parseFrontMatter(text: string): {
  attributes: Record<string, string>;
  body: string;
} {
  if (!text.startsWith("---")) {
    return { attributes: {}, body: text };
  }
  const end = text.indexOf("\n---", 3);
  if (end === -1) {
    return { attributes: {}, body: text };
  }

  const header = text.slice(3, end).trim();
  const body = text.slice(end + 4).replace(/^\r?\n/, "");
  const attributes: Record<string, string> = {};

  for (const line of header.split("\n")) {
    const match = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line.trim());
    if (!match?.[1]) {
      continue;
    }
    attributes[match[1]] = stripQuotes(match[2] ?? "");
  }

  return { attributes, body };
}

function stripQuotes(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

export function toSkillId(value: string): string {
  const id = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 100);
  return id.length > 0 ? id : "skill";
}

/**
 * Imports Claude-style skills: a directory of folders, each holding a SKILL.md
 * whose front matter carries the name and description.
 */
export class ClaudeSkillImporter implements SkillImporter {
  readonly id = "claude-skill";
  readonly displayName = "Claude skill folder";

  async canImport(path: string): Promise<boolean> {
    return (await this.#skillFiles(path)).length > 0;
  }

  async import(path: string): Promise<SkillManifestInput[]> {
    const skills: SkillManifestInput[] = [];

    for (const file of await this.#skillFiles(path)) {
      const text = await readFile(file, "utf8");
      const { attributes, body } = parseFrontMatter(text);
      const folder = basename(join(file, ".."));
      const name = attributes["name"] ?? folder;

      skills.push({
        schemaVersion: 1,
        id: toSkillId(attributes["id"] ?? name),
        name,
        description: attributes["description"] ?? "",
        version: attributes["version"] ?? "1.0.0",
        instructions: body.trim(),
        source: { kind: "import", path: file, importer: this.id },
      });
    }

    return skills;
  }

  async #skillFiles(path: string): Promise<string[]> {
    try {
      const entries = await readdir(path, { withFileTypes: true });
      const files: string[] = [];
      for (const entry of entries) {
        if (!entry.isDirectory()) {
          continue;
        }
        const candidate = join(path, entry.name, "SKILL.md");
        try {
          if ((await stat(candidate)).isFile()) {
            files.push(candidate);
          }
        } catch {
          continue;
        }
      }
      return files;
    } catch {
      return [];
    }
  }
}

/** Imports plain Markdown files, taking the name from the first heading. */
export class MarkdownSkillImporter implements SkillImporter {
  readonly id = "markdown";
  readonly displayName = "Markdown files";

  async canImport(path: string): Promise<boolean> {
    return (await this.#markdownFiles(path)).length > 0;
  }

  async import(path: string): Promise<SkillManifestInput[]> {
    const skills: SkillManifestInput[] = [];

    for (const file of await this.#markdownFiles(path)) {
      const text = await readFile(file, "utf8");
      const { body } = parseFrontMatter(text);
      const heading = /^#\s+(.+)$/m.exec(body)?.[1]?.trim();
      const name = heading ?? basename(file, ".md");

      skills.push({
        schemaVersion: 1,
        id: toSkillId(name),
        name,
        description: firstParagraph(body),
        instructions: body.trim(),
        source: { kind: "import", path: file, importer: this.id },
      });
    }

    return skills;
  }

  async #markdownFiles(path: string): Promise<string[]> {
    try {
      const stats = await stat(path);
      if (stats.isFile()) {
        return path.endsWith(".md") ? [path] : [];
      }
      const entries = await readdir(path, { withFileTypes: true });
      return entries
        .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
        .map((entry) => join(path, entry.name));
    } catch {
      return [];
    }
  }
}

function firstParagraph(body: string): string {
  const withoutHeading = body.replace(/^#\s+.+$/m, "").trim();
  const paragraph = withoutHeading.split(/\n\s*\n/)[0] ?? "";
  return paragraph.replace(/\s+/g, " ").trim().slice(0, 300);
}

/**
 * One skill folder, as a tool keeps it: a SKILL.md whose front matter names
 * it. Used for skills found in a tool's own folders.
 */
export async function importSkillFolder(folder: string): Promise<SkillManifestInput> {
  const file = join(folder, "SKILL.md");
  const text = await readFile(file, "utf8");
  const { attributes, body } = parseFrontMatter(text);
  const name = attributes["name"] ?? basename(folder);
  if (body.trim() === "") {
    throw new Error("The skill has no instructions.");
  }
  return {
    schemaVersion: 1,
    id: toSkillId(attributes["id"] ?? name),
    name,
    description: attributes["description"] ?? "",
    version: attributes["version"] ?? "1.0.0",
    instructions: body.trim(),
    source: { kind: "import", path: file, importer: "tool-skill" },
  };
}

/**
 * One Markdown file: a SKILL.md with front matter, or any Markdown, named by
 * its first heading or its file name.
 */
export async function importSkillFile(file: string): Promise<SkillManifestInput> {
  const text = await readFile(file, "utf8");
  const { attributes, body } = parseFrontMatter(text);
  const heading = /^#\s+(.+)$/m.exec(body)?.[1]?.trim();
  const stem = basename(file).replace(/\.(md|markdown)$/i, "");
  const name =
    attributes["name"] ?? heading ?? (stem.toUpperCase() === "SKILL" ? basename(join(file, "..")) : stem);
  if (body.trim() === "") {
    throw new Error("The file is empty.");
  }
  return {
    schemaVersion: 1,
    id: toSkillId(attributes["id"] ?? name),
    name,
    description: attributes["description"] ?? firstParagraph(body),
    version: attributes["version"] ?? "1.0.0",
    instructions: body.trim(),
    source: { kind: "import", path: file, importer: "markdown-file" },
  };
}
