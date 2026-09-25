import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import type { Logger } from "@ai-workbench/shared";
import { CliTransport } from "@ai-workbench/transport-cli";
import { notARepository, parseStatus, type GitStatus } from "./parse.js";

export interface GitServiceOptions {
  readonly logger: Logger;
  /** Overrides the git executable; otherwise it is looked up on PATH. */
  readonly executablePath?: string | undefined;
}

/**
 * Repository information for a workspace (spec §28). Git is optional: a
 * workspace that is not a repository, or a machine without git, reports "not a
 * repository" rather than failing.
 */
export class GitService {
  readonly #transport: CliTransport;
  readonly #logger: Logger;

  constructor(options: GitServiceOptions) {
    this.#logger = options.logger.child("WORKSPACE");
    this.#transport = new CliTransport({
      command: "git",
      configuredPath: options.executablePath,
      logger: options.logger,
      defaultTimeoutMs: 15_000,
    });
  }

  async isAvailable(): Promise<boolean> {
    return (await this.#transport.locate()) !== null;
  }

  async status(workingDirectory: string): Promise<GitStatus> {
    if (!(await this.isAvailable())) {
      return notARepository;
    }

    try {
      const { stdout, exit } = await this.#transport.exec({
        args: [
          "status",
          "--porcelain=v2",
          "--branch",
          "--untracked-files=normal",
        ],
        cwd: workingDirectory,
      });

      if (exit.code !== 0) {
        // The usual case is simply "not a git repository".
        return notARepository;
      }
      return parseStatus(stdout);
    } catch (error) {
      this.#logger.debug("Git status failed", {
        workingDirectory,
        error: error instanceof Error ? error.message : String(error),
      });
      return notARepository;
    }
  }

  /** Unified diff for one file (spec §28). Empty when there is nothing to show. */
  async diff(workingDirectory: string, relativePath: string, staged: boolean): Promise<string> {
    if (!(await this.isAvailable())) {
      return "";
    }
    try {
      const { stdout, exit } = await this.#transport.exec({
        args: staged
          ? ["diff", "--cached", "--", relativePath]
          : ["diff", "--", relativePath],
        cwd: workingDirectory,
      });
      if (exit.code !== 0) {
        return "";
      }
      return stdout.slice(0, 200 * 1024);
    } catch (error) {
      this.#logger.debug("Git diff failed", {
        workingDirectory,
        error: error instanceof Error ? error.message : String(error),
      });
      return "";
    }
  }

  /**
   * The working tree as it is right now — tracked files and new ones, as
   * .gitignore allows — recorded as a git tree, or null when the folder is no
   * repository. Nothing of the person's is touched: the files are added to a
   * throwaway copy of the index, never to the index, HEAD, a branch or the
   * stash; the tree only adds objects git collects again on its own.
   */
  async snapshot(workingDirectory: string): Promise<string | null> {
    if (!(await this.isAvailable())) {
      return null;
    }
    const scratch = await mkdtemp(join(tmpdir(), "ai-workbench-snapshot-"));
    const index = join(scratch, "index");
    try {
      const where = await this.#transport.exec({
        args: ["rev-parse", "--path-format=absolute", "--git-path", "index"],
        cwd: workingDirectory,
      });
      if (where.exit.code !== 0) {
        return null;
      }
      // Starting from the real index keeps git from hashing every file anew.
      const path = where.stdout.trim();
      if (path) {
        const real = isAbsolute(path) ? path : join(workingDirectory, path);
        await copyFile(real, index).catch(() => undefined);
      }
      const env = { GIT_INDEX_FILE: index };
      const added = await this.#transport.exec({ args: ["add", "--all", "--", "."], cwd: workingDirectory, env });
      if (added.exit.code !== 0) {
        return null;
      }
      const tree = await this.#transport.exec({ args: ["write-tree"], cwd: workingDirectory, env });
      const id = tree.stdout.trim();
      return tree.exit.code === 0 && /^[0-9a-f]{40,64}$/.test(id) ? id : null;
    } catch (error) {
      this.#logger.debug("Git snapshot failed", {
        workingDirectory,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    } finally {
      await rm(scratch, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  /**
   * What changed between two snapshots: the files and their unified diff,
   * capped at `limit` characters. Empty when nothing changed.
   */
  async compare(
    workingDirectory: string,
    before: string,
    after: string,
    limit = 150 * 1024,
  ): Promise<{ files: string[]; diff: string; truncated: boolean }> {
    const none = { files: [], diff: "", truncated: false };
    if (before === after) {
      return none;
    }
    try {
      const names = await this.#transport.exec({
        args: ["diff", "--name-only", "--no-renames", before, after],
        cwd: workingDirectory,
      });
      if (names.exit.code !== 0) {
        return none;
      }
      const files = names.stdout.split("\n").map((line) => line.trim()).filter(Boolean);
      if (files.length === 0) {
        return none;
      }
      const diff = await this.#transport.exec({
        args: ["diff", "--no-color", "--no-ext-diff", "--find-renames", before, after],
        cwd: workingDirectory,
      });
      if (diff.exit.code !== 0) {
        return { files, diff: "", truncated: false };
      }
      const truncated = diff.stdout.length > limit;
      return { files, diff: truncated ? diff.stdout.slice(0, limit) : diff.stdout, truncated };
    } catch (error) {
      this.#logger.debug("Git compare failed", {
        workingDirectory,
        error: error instanceof Error ? error.message : String(error),
      });
      return none;
    }
  }
}
