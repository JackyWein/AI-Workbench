import { posix } from "node:path";
import type ssh2 from "ssh2";
import type { Logger } from "@ai-workbench/shared";
import {
  PathBoundaryError,
  isBinary,
  isListedName,
  byDirectoryThenNameOrder,
  resolvePosixInsideRoot,
  toPosixRelativePath,
  type DirectoryEntry,
  type FileContents,
  type WorkspaceFileSystem,
} from "@ai-workbench/workspace-fs";
import type { SshConnectionPool, SshTarget } from "./connection.js";

type SFTPWrapper = ssh2.SFTPWrapper;
type Stats = ssh2.Stats;

/** Resolves which machine a workspace root lives on, when one is asked for. */
export type SshTargetResolver = (connectionId: string) => Promise<SshTarget>;

export interface SshWorkspaceFileSystemOptions {
  readonly logger: Logger;
  readonly pool: SshConnectionPool;
  readonly resolveTarget: SshTargetResolver;
  readonly maxReadBytes?: number;
  readonly maxWriteBytes?: number;
}

/**
 * A workspace root on another machine, reached over SFTP (spec §25, §27).
 *
 * It owes everything the local implementation owes, and the reasons are the
 * same: a path is resolved inside the root through symbolic links, binary
 * content is never returned as text or written, and reads and writes are
 * capped. The boundary matters more here, not less — a link pointing at `/etc`
 * on a server is exactly as easy to follow as one pointing at `/etc` locally.
 *
 * The root is addressed as `connectionId:/absolute/path`, because "which
 * machine" and "which directory" together are what identifies a remote root,
 * and the layer above hands file operations a single root string.
 */
export class SshWorkspaceFileSystem implements WorkspaceFileSystem {
  readonly #logger: Logger;
  readonly #pool: SshConnectionPool;
  readonly #resolveTarget: SshTargetResolver;
  readonly #maxReadBytes: number;
  readonly #maxWriteBytes: number;

  constructor(options: SshWorkspaceFileSystemOptions) {
    this.#logger = options.logger.child("SSH_FS");
    this.#pool = options.pool;
    this.#resolveTarget = options.resolveTarget;
    this.#maxReadBytes = options.maxReadBytes ?? 512 * 1024;
    this.#maxWriteBytes = options.maxWriteBytes ?? 512 * 1024;
  }

  async list(root: string, relativePath = ""): Promise<DirectoryEntry[]> {
    const { connectionId, path: rootPath } = parseRemoteRoot(root);
    return this.#run(connectionId, async (sftp) => {
      const realRoot = await realPath(sftp, rootPath);
      const directory = await this.#resolveInside(sftp, rootPath, relativePath);
      const entries = await readdir(sftp, directory);

      const results: DirectoryEntry[] = [];
      for (const entry of entries) {
        if (!isListedName(entry.filename, isDirectory(entry.attrs))) {
          continue;
        }
        const absolute = posix.join(directory, entry.filename);
        try {
          // stat rather than lstat, so a link to a file is described as a
          // file; reading it still goes through the boundary check.
          const stats = await stat(sftp, absolute);
          results.push({
            name: entry.filename,
            path: toPosixRelativePath(realRoot, absolute),
            kind: isDirectory(stats) ? "directory" : isFile(stats) ? "file" : "other",
            size: stats.size ?? 0,
            modifiedAt: modifiedAt(stats),
          });
        } catch {
          // A broken link or a file removed while listing is simply skipped.
          continue;
        }
      }
      return results.sort(byDirectoryThenNameOrder);
    });
  }

  async readText(root: string, relativePath: string): Promise<FileContents> {
    const { connectionId, path: rootPath } = parseRemoteRoot(root);
    return this.#run(connectionId, async (sftp) => {
      const realRoot = await realPath(sftp, rootPath);
      const absolute = await this.#resolveInside(sftp, rootPath, relativePath);
      const stats = await stat(sftp, absolute);
      if (!isFile(stats)) {
        throw new PathBoundaryError(`"${relativePath}" is not a file`);
      }

      // Only the capped prefix is fetched: pulling a gigabyte across the
      // network to throw away all but the first half megabyte would make a
      // mistyped click feel like a hang.
      const buffer = await readPrefix(sftp, absolute, this.#maxReadBytes + 1);
      const limited = buffer.subarray(0, this.#maxReadBytes);
      const size = stats.size ?? buffer.length;

      if (isBinary(limited)) {
        return {
          path: toPosixRelativePath(realRoot, absolute),
          content: "",
          truncated: false,
          size,
          binary: true,
        };
      }
      return {
        path: toPosixRelativePath(realRoot, absolute),
        content: limited.toString("utf8"),
        truncated: buffer.length > limited.length,
        size,
        binary: false,
      };
    });
  }

  async writeText(
    root: string,
    relativePath: string,
    content: string,
  ): Promise<DirectoryEntry> {
    const { connectionId, path: rootPath } = parseRemoteRoot(root);
    const buffer = Buffer.from(content, "utf8");
    if (buffer.length > this.#maxWriteBytes) {
      throw new PathBoundaryError(
        `"${relativePath}" is larger than the ${this.#maxWriteBytes} byte write limit`,
      );
    }
    if (buffer.subarray(0, 8000).includes(0)) {
      throw new PathBoundaryError(`"${relativePath}" looks like a binary file`);
    }
    await this.#run(connectionId, async (sftp) => {
      const absolute = await this.#resolveInside(sftp, rootPath, relativePath);
      await writeFile(sftp, absolute, buffer);
    });
    return this.describe(root, relativePath);
  }

  async describe(root: string, relativePath: string): Promise<DirectoryEntry> {
    const { connectionId, path: rootPath } = parseRemoteRoot(root);
    return this.#run(connectionId, async (sftp) => {
      const realRoot = await realPath(sftp, rootPath);
      const absolute = await this.#resolveInside(sftp, rootPath, relativePath);
      const stats = await stat(sftp, absolute);
      return {
        name: posix.basename(absolute),
        path: toPosixRelativePath(realRoot, absolute),
        kind: isDirectory(stats) ? "directory" : isFile(stats) ? "file" : "other",
        size: stats.size ?? 0,
        modifiedAt: modifiedAt(stats),
      };
    });
  }

  async exists(root: string, relativePath: string): Promise<boolean> {
    try {
      await this.describe(root, relativePath);
      return true;
    } catch (error) {
      if (error instanceof PathBoundaryError) {
        throw error;
      }
      this.#logger.debug("Remote path does not exist", { relativePath });
      return false;
    }
  }

  /**
   * Confirms a directory really is one, and answers with the path the host
   * resolved. This is what a workspace is checked with before it is created.
   */
  async verifyDirectory(connectionId: string, path: string): Promise<string> {
    return this.#run(connectionId, async (sftp) => {
      const resolved = await realPath(sftp, path);
      const stats = await stat(sftp, resolved);
      if (!isDirectory(stats)) {
        throw new PathBoundaryError(`"${path}" is not a directory`);
      }
      return resolved;
    });
  }

  /** The home directory the host resolves, which proves SFTP really works. */
  async homeDirectory(connectionId: string): Promise<string> {
    return this.#run(connectionId, (sftp) => realPath(sftp, "."));
  }

  async #run<T>(connectionId: string, work: (sftp: SFTPWrapper) => Promise<T>): Promise<T> {
    const target = await this.#resolveTarget(connectionId);
    return this.#pool.withSftp(target, work);
  }

  /**
   * The boundary check, in two steps like the local one: lexically first, then
   * against where the path really points, because a symbolic link can leave
   * the root while looking innocent.
   */
  async #resolveInside(
    sftp: SFTPWrapper,
    rootPath: string,
    relativePath: string,
  ): Promise<string> {
    const target = resolvePosixInsideRoot(rootPath, relativePath);
    const realRoot = await realPath(sftp, rootPath);

    let realTarget: string;
    try {
      realTarget = await realPath(sftp, target);
    } catch {
      // The path does not exist yet, so the lexical check above is all there
      // is — the same answer the local implementation gives.
      return target;
    }
    // Re-checked against the real root: a link is only safe if where it
    // actually lands is still inside.
    return resolvePosixInsideRoot(realRoot, realTarget);
  }
}

/**
 * A remote root is one string so the layer above can stay unaware of where a
 * workspace lives. The connection id is opaque and generated by the
 * application, so it never contains the separator.
 */
export function remoteRoot(connectionId: string, path: string): string {
  return `${connectionId}:${path}`;
}

export function parseRemoteRoot(root: string): { connectionId: string; path: string } {
  const separator = root.indexOf(":");
  if (separator <= 0) {
    throw new PathBoundaryError(`"${root}" is not a root on a connection`);
  }
  const path = root.slice(separator + 1);
  if (!posix.isAbsolute(path)) {
    throw new PathBoundaryError(`"${root}" does not name an absolute path`);
  }
  return { connectionId: root.slice(0, separator), path };
}

export function isRemoteRoot(root: string): boolean {
  return /^[^:/\\]+:\//.test(root);
}

// --- the SFTP protocol, as promises ---------------------------------------

function realPath(sftp: SFTPWrapper, path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    sftp.realpath(path, (error, resolved) =>
      error ? reject(error) : resolve(resolved),
    );
  });
}

function stat(sftp: SFTPWrapper, path: string): Promise<Stats> {
  return new Promise((resolve, reject) => {
    sftp.stat(path, (error, stats) => (error ? reject(error) : resolve(stats)));
  });
}

function readdir(sftp: SFTPWrapper, path: string): Promise<ssh2.FileEntry[]> {
  return new Promise((resolve, reject) => {
    sftp.readdir(path, (error, entries) => (error ? reject(error) : resolve(entries)));
  });
}

/** Reads at most `limit` bytes, so a huge file costs one chunk, not all of it. */
function readPrefix(sftp: SFTPWrapper, path: string, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    const stream = sftp.createReadStream(path, { start: 0, end: limit - 1 });
    stream.on("data", (chunk: Buffer | string) => {
      const buffer = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
      chunks.push(buffer);
      total += buffer.length;
      if (total >= limit) {
        stream.destroy();
      }
    });
    stream.on("error", reject);
    stream.on("close", () => resolve(Buffer.concat(chunks).subarray(0, limit)));
  });
}

function writeFile(sftp: SFTPWrapper, path: string, buffer: Buffer): Promise<void> {
  return new Promise((resolve, reject) => {
    const stream = sftp.createWriteStream(path);
    stream.on("error", reject);
    // "close" rather than "finish": the bytes are only really on the other
    // machine once the handle is closed, and saving must not report success
    // before that.
    stream.on("close", () => resolve());
    stream.end(buffer);
  });
}

function isDirectory(stats: Stats | ssh2.Attributes): boolean {
  return typeof stats.mode === "number" && (stats.mode & 0o170000) === 0o040000;
}

function isFile(stats: Stats | ssh2.Attributes): boolean {
  return typeof stats.mode === "number" && (stats.mode & 0o170000) === 0o100000;
}

function modifiedAt(stats: Stats): Date {
  return new Date((stats.mtime ?? 0) * 1000);
}
