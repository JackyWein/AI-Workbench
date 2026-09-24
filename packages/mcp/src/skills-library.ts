import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, normalize, relative, resolve } from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

/** One skill as the library keeps it on disk. */
export interface LibrarySkill {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly instructions: string;
  /** Offered to every session; the others are offered where enabled. */
  readonly enabled: boolean;
  /** The folder the skill came from, for the scripts and files it refers to. */
  readonly folder?: string | undefined;
}

interface IndexEntry {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly enabled: boolean;
  readonly folder: string | null;
}

const INDEX = "library.json";
/** A skill's own files are read in pieces this large. */
const READ_LIMIT = 40_000;

/**
 * Writes the skills the application knows into a folder the skills server
 * reads: one SKILL.md per skill and an index. Skills that were removed
 * disappear from the folder too.
 */
export async function writeSkillsLibrary(root: string, skills: readonly LibrarySkill[]): Promise<void> {
  await mkdir(root, { recursive: true });
  const keep = new Set<string>();
  const index: IndexEntry[] = [];
  for (const skill of skills) {
    keep.add(skill.id);
    const folder = join(root, skill.id);
    await mkdir(folder, { recursive: true });
    await writeFile(join(folder, "SKILL.md"), skill.instructions, "utf8");
    index.push({
      id: skill.id,
      name: skill.name,
      description: skill.description,
      enabled: skill.enabled,
      folder: skill.folder ?? null,
    });
  }
  await writeFile(join(root, INDEX), JSON.stringify(index, null, 2), "utf8");
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (entry.isDirectory() && !keep.has(entry.name)) {
      await rm(join(root, entry.name), { recursive: true, force: true });
    }
  }
}

async function readIndex(root: string): Promise<IndexEntry[]> {
  try {
    const parsed: unknown = JSON.parse(await readFile(join(root, INDEX), "utf8"));
    return Array.isArray(parsed) ? (parsed as IndexEntry[]) : [];
  } catch {
    return [];
  }
}

function find(index: readonly IndexEntry[], name: string): IndexEntry | undefined {
  const wanted = name.trim().toLowerCase();
  return index.find((entry) => entry.id === wanted || entry.name.toLowerCase() === wanted);
}

/**
 * What every connected agent is told: which skills there are, one line each,
 * and to load one before a task it matches. The full text costs nothing until
 * it is needed — the same progressive disclosure the tools use for their own
 * skills, available to all of them alike.
 */
export function skillsInstructions(index: readonly Pick<IndexEntry, "name" | "description" | "enabled">[]): string {
  const offered = index.filter((entry) => entry.enabled);
  const head =
    "Skills are reusable instructions for particular kinds of work. When a task matches a skill below, call skill_read with its name before starting and follow it; read files it mentions with skill_file. Do not load skills a task does not need.";
  if (offered.length === 0) {
    return `${head} No skills are switched on right now; skill_list shows the ones that exist.`;
  }
  return [
    head,
    "Available skills:",
    ...offered.map((entry) => `- ${entry.name}: ${entry.description.replace(/\s+/g, " ").slice(0, 300)}`),
  ].join("\n");
}

type ToolReply = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

function text(value: string, isError = false): ToolReply {
  return { content: [{ type: "text", text: value }], ...(isError ? { isError } : {}) };
}

/** The MCP server over one library folder. Reads the folder on every call. */
export async function createSkillsServer(root: string): Promise<Server> {
  const initial = await readIndex(root);
  const server = new Server(
    { name: "ai-workbench-skills", version: "0.0.7" },
    { capabilities: { tools: {} }, instructions: skillsInstructions(initial) },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "skill_list",
        description: "List the skills that exist: name, whether it is switched on, and what it is for.",
        inputSchema: { type: "object" as const, properties: {} },
      },
      {
        name: "skill_read",
        description:
          "Load a skill's full instructions by name. Call it before a task the skill's description matches, then follow them.",
        inputSchema: {
          type: "object" as const,
          properties: { name: { type: "string" } },
          required: ["name"],
        },
      },
      {
        name: "skill_file",
        description:
          "Read a file a skill refers to (a script, a template, a reference) by its path relative to the skill's folder.",
        inputSchema: {
          type: "object" as const,
          properties: { name: { type: "string" }, path: { type: "string" }, offset: { type: "integer", minimum: 0 } },
          required: ["name", "path"],
        },
      },
    ],
  }));
  server.setRequestHandler(CallToolRequestSchema, async (request): Promise<ToolReply> => {
    const args = (request.params.arguments ?? {}) as Record<string, unknown>;
    const index = await readIndex(root);
    if (request.params.name === "skill_list") {
      return text(
        index.length === 0
          ? "No skills yet."
          : index
              .map((entry) => `- ${entry.name}${entry.enabled ? "" : " (off)"}: ${entry.description}`)
              .join("\n"),
      );
    }
    const name = typeof args["name"] === "string" ? args["name"] : "";
    const entry = find(index, name);
    if (!entry) {
      return text(`There is no skill named "${name}". Call skill_list to see them.`, true);
    }
    if (request.params.name === "skill_read") {
      const body = await readFile(join(root, entry.id, "SKILL.md"), "utf8").catch(() => null);
      if (body === null) {
        return text(`The skill "${entry.name}" could not be read.`, true);
      }
      const folder = entry.folder ? `\n\n(Files this skill mentions: read them with skill_file, relative to its folder.)` : "";
      return text(`# ${entry.name}\n\n${body}${folder}`);
    }
    if (request.params.name === "skill_file") {
      if (!entry.folder) {
        return text(`The skill "${entry.name}" has no files of its own.`, true);
      }
      const requested = typeof args["path"] === "string" ? args["path"] : "";
      const target = resolve(entry.folder, normalize(requested));
      const inside = relative(entry.folder, target);
      if (!requested || inside.startsWith("..") || isAbsolute(inside)) {
        return text("Only files inside the skill's own folder can be read.", true);
      }
      const info = await stat(target).catch(() => null);
      if (!info?.isFile()) {
        return text(`"${requested}" is not a file of this skill.`, true);
      }
      const offset = typeof args["offset"] === "number" && args["offset"] > 0 ? Math.floor(args["offset"]) : 0;
      const content = await readFile(target, "utf8");
      const part = content.slice(offset, offset + READ_LIMIT);
      const more = offset + READ_LIMIT < content.length ? `\n\n[continues — offset ${offset + READ_LIMIT}]` : "";
      return text(`${part}${more}`);
    }
    return text(`Unknown tool ${request.params.name}.`, true);
  });
  return server;
}

/** Serves a library over stdio; how the application starts it for the tools. */
export async function serveSkillsLibrary(root: string): Promise<void> {
  const server = await createSkillsServer(root);
  await server.connect(new StdioServerTransport());
}

/** The folder a skill imported from a SKILL.md file lives in, when it has one. */
export function skillFolderOf(sourcePath: string | undefined): string | undefined {
  if (!sourcePath) {
    return undefined;
  }
  return sourcePath.toLowerCase().endsWith(".md") ? dirname(sourcePath) : sourcePath;
}
