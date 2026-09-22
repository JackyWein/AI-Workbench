import { readdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import type { Logger } from "@ai-workbench/shared";
import {
  PathBoundaryError,
  resolveRealPathInsideRoot,
  toRelativePath,
} from "./paths.js";
import { resolve } from "node:path";

export type EntryKind = "file" | "directory" | "other";

export interface DirectoryEntry {
  readonly name: string;
  /** Relative to the workspace root, with forward slashes. */
  readonly path: string;
  readonly kind: EntryKind;
  readonly size: number;
  readonly modifiedAt: Date;
}

export interface FileContents {
  readonly path: string;
  readonly content: string;
  /** True when the file was longer than the requested limit. */
  readonly truncated: boolean;
  readonly size: number;
  /** Binary files are never returned as text. */
  readonly binary: boolean;
}

/**
 * What the application needs from a workspace root, and the only thing above
 * it ever sees (spec §27). A root on this computer and a root on another
 * machine answer the same five questions, so the file browser, the editor and
 * everything built on them do not know, and must not care, which one they have.
 *
 * Every implementation owes the same promises: a path is resolved inside the
 * root even through symbolic links, binary content is never returned as text
 * or written, and reads and writes are size-capped.
 */
export interface WorkspaceFileSystem {
  /** Lists one directory. Directories come first, then files, both by name. */
  list(root: string, relativePath?: string): Promise<DirectoryEntry[]>;
  /** Reads a text file, refusing binary content and capping the size. */
  readText(root: string, relativePath: string): Promise<FileContents>;
  /** Writes a text file inside the root (spec §27: open/edit/save). */
  writeText(root: string, relativePath: string, content: string): Promise<DirectoryEntry>;
  describe(root: string, relativePath: string): Promise<DirectoryEntry>;
  /** Whether a path exists inside the root, without throwing on absence. */
  exists(root: string, relativePath: string): Promise<boolean>;
}

export interface WorkspaceFileSystemOptions {
  readonly logger: Logger;
  /** Largest file returned as text. Larger files come back truncated. */
  readonly maxReadBytes?: number;
}

/** Directories that are noise in a project tree and expensive to walk. */
const HIDDEN_DIRECTORIES = new Set([
  "node_modules",
  ".git",
  ".pnpm-store",
  ".turbo",
  "dist",
  "out",
  "release",
  "coverage",
  ".next",
  ".cache",
]);

/**
 * A workspace root on this computer (spec §27). Every path is resolved inside
 * the workspace root, including through symbolic links. Reads refuse binary
 * content; writes refuse binary content and are size-capped.
 */
export class LocalWorkspaceFileSystem implements WorkspaceFileSystem {
  readonly #logger: Logger;
  readonly #maxReadBytes: number;
  readonly #maxWriteBytes: number;

  constructor(options: WorkspaceFileSystemOptions & { maxWriteBytes?: number }) {
    this.#logger = options.logger.child("WORKSPACE");
    this.#maxReadBytes = options.maxReadBytes ?? 512 * 1024;
    this.#maxWriteBytes = options.maxWriteBytes ?? 512 * 1024;
  }

  /** Lists one directory. Directories come first, then files, both by name. */
  async list(root: string, relativePath = ""): Promise<DirectoryEntry[]> {
    const realRoot = await this.#realRoot(root);
    const directory = await resolveRealPathInsideRoot(root, relativePath);
    const entries = await readdir(directory, { withFileTypes: true });

    const results: DirectoryEntry[] = [];
    for (const entry of entries) {
      if (entry.name.startsWith(".") && entry.name !== ".gitignore") {
        continue;
      }
      if (entry.isDirectory() && HIDDEN_DIRECTORIES.has(entry.name)) {
        continue;
      }

      const absolute = join(directory, entry.name);
      try {
        // stat rather than lstat, so a link to a file is described as a file;
        // reading it still goes through the boundary check.
        const stats = await stat(absolute);
        results.push({
          name: entry.name,
          path: toRelativePath(realRoot, absolute),
          kind: stats.isDirectory() ? "directory" : stats.isFile() ? "file" : "other",
          size: stats.size,
          modifiedAt: stats.mtime,
        });
      } catch {
        // A broken link or a file removed while listing is simply skipped.
        continue;
      }
    }

    return results.sort(byDirectoryThenName);
  }

  /** Reads a text file, refusing binary content and capping the size. */
  async readText(root: string, relativePath: string): Promise<FileContents> {
    const realRoot = await this.#realRoot(root);
    const absolute = await resolveRealPathInsideRoot(root, relativePath);
    const stats = await stat(absolute);

    if (!stats.isFile()) {
      throw new PathBoundaryError(`"${relativePath}" is not a file`);
    }

    const buffer = await readFile(absolute);
    const limited = buffer.subarray(0, this.#maxReadBytes);

    if (isBinary(limited)) {
      return {
        path: toRelativePath(realRoot, absolute),
        content: "",
        truncated: false,
        size: stats.size,
        binary: true,
      };
    }

    return {
      path: toRelativePath(realRoot, absolute),
      content: limited.toString("utf8"),
      truncated: buffer.length > limited.length,
      size: stats.size,
      binary: false,
    };
  }

  /** Writes a text file inside the workspace (spec §27: open/edit/save). */
  async writeText(root: string, relativePath: string, content: string): Promise<DirectoryEntry> {
    const absolute = await resolveRealPathInsideRoot(root, relativePath);
    const buffer = Buffer.from(content, "utf8");
    if (buffer.length > this.#maxWriteBytes) {
      throw new PathBoundaryError(
        `"${relativePath}" is larger than the ${this.#maxWriteBytes} byte write limit`,
      );
    }
    if (buffer.subarray(0, 8000).includes(0)) {
      throw new PathBoundaryError(`"${relativePath}" looks like a binary file`);
    }
    await writeFile(absolute, buffer);
    return this.describe(root, relativePath);
  }

  async describe(root: string, relativePath: string): Promise<DirectoryEntry> {    const realRoot = await this.#realRoot(root);
    const absolute = await resolveRealPathInsideRoot(root, relativePath);
    const stats = await stat(absolute);
    return {
      name: basename(absolute),
      path: toRelativePath(realRoot, absolute),
      kind: stats.isDirectory() ? "directory" : stats.isFile() ? "file" : "other",
      size: stats.size,
      modifiedAt: stats.mtime,
    };
  }

  async #realRoot(root: string): Promise<string> {
    return realRootOf(root);
  }

  /** Whether a path exists inside the root, without throwing on absence. */
  async exists(root: string, relativePath: string): Promise<boolean> {
    try {
      await this.describe(root, relativePath);
      return true;
    } catch (error) {
      if (error instanceof PathBoundaryError) {
        throw error;
      }
      this.#logger.debug("Path does not exist", { relativePath });
      return false;
    }
  }
}

/**
 * Entries are resolved through their real path, so relative paths have to be
 * computed against the real root as well.
 */
async function realRootOf(root: string): Promise<string> {
  try {
    return await realpath(resolve(root));
  } catch {
    return resolve(root);
  }
}

function byDirectoryThenName(a: DirectoryEntry, b: DirectoryEntry): number {
  if (a.kind !== b.kind) {
    return a.kind === "directory" ? -1 : 1;
  }
  return a.name.localeCompare(b.name);
}

/** A NUL byte in the first chunk is the usual signal that a file is binary. */
export function isBinary(buffer: Buffer): boolean {
  const sample = buffer.subarray(0, 8000);
  return sample.includes(0);
}

/** Directories every implementation leaves out of a project tree. */
export const hiddenDirectories: ReadonlySet<string> = HIDDEN_DIRECTORIES;

/** The one ordering a listing is presented in, wherever it came from. */
export function byDirectoryThenNameOrder(a: DirectoryEntry, b: DirectoryEntry): number {
  return byDirectoryThenName(a, b);
}

/** Whether a listing shows this entry: dotfiles are noise, .gitignore is not. */
export function isListedName(name: string, isDirectory: boolean): boolean {
  if (name.startsWith(".") && name !== ".gitignore") {
    return false;
  }
  return !(isDirectory && HIDDEN_DIRECTORIES.has(name));
}
