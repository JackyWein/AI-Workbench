import { readdir, readFile, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import type { Logger } from "@ai-workbench/shared";
import {
  PathBoundaryError,
  resolveRealPathInsideRoot,
  toRelativePath,
} from "./paths.js";

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
 * The only way the application reads a workspace from disk (spec §27). Every
 * path is resolved inside the workspace root, including through symbolic links,
 * and nothing here can write.
 */
export class WorkspaceFileSystem {
  readonly #logger: Logger;
  readonly #maxReadBytes: number;

  constructor(options: WorkspaceFileSystemOptions) {
    this.#logger = options.logger.child("WORKSPACE");
    this.#maxReadBytes = options.maxReadBytes ?? 512 * 1024;
  }

  /** Lists one directory. Directories come first, then files, both by name. */
  async list(root: string, relativePath = ""): Promise<DirectoryEntry[]> {
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
          path: toRelativePath(root, absolute),
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
    const absolute = await resolveRealPathInsideRoot(root, relativePath);
    const stats = await stat(absolute);

    if (!stats.isFile()) {
      throw new PathBoundaryError(`"${relativePath}" is not a file`);
    }

    const buffer = await readFile(absolute);
    const limited = buffer.subarray(0, this.#maxReadBytes);

    if (isBinary(limited)) {
      return {
        path: toRelativePath(root, absolute),
        content: "",
        truncated: false,
        size: stats.size,
        binary: true,
      };
    }

    return {
      path: toRelativePath(root, absolute),
      content: limited.toString("utf8"),
      truncated: buffer.length > limited.length,
      size: stats.size,
      binary: false,
    };
  }

  async describe(root: string, relativePath: string): Promise<DirectoryEntry> {
    const absolute = await resolveRealPathInsideRoot(root, relativePath);
    const stats = await stat(absolute);
    return {
      name: basename(absolute),
      path: toRelativePath(root, absolute),
      kind: stats.isDirectory() ? "directory" : stats.isFile() ? "file" : "other",
      size: stats.size,
      modifiedAt: stats.mtime,
    };
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

function byDirectoryThenName(a: DirectoryEntry, b: DirectoryEntry): number {
  if (a.kind !== b.kind) {
    return a.kind === "directory" ? -1 : 1;
  }
  return a.name.localeCompare(b.name);
}

/** A NUL byte in the first chunk is the usual signal that a file is binary. */
function isBinary(buffer: Buffer): boolean {
  const sample = buffer.subarray(0, 8000);
  return sample.includes(0);
}
