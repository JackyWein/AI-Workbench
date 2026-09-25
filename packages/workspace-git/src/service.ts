import { copyFile, lstat, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { Logger } from "@ai-workbench/shared";
import { CliTransport } from "@ai-workbench/transport-cli";
import { startAskpass } from "./askpass.js";
import { notARepository, parseStatus, type GitStatus } from "./parse.js";

/** A user name and secret for one remote, handed to git through askpass only. */
export interface GitRemoteCredentials {
  readonly username: string;
  readonly password: string;
}

/**
 * Where credentials for a remote come from. Null lets git do what it would
 * do in a terminal — its own credential helper, an SSH key.
 */
export type GitCredentialSource = (remoteUrl: string) => Promise<GitRemoteCredentials | null>;

/** Git refused; the message is git's own. */
export class GitCommandError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GitCommandError";
  }
}

/** How long a pull or push may take. */
const REMOTE_TIMEOUT_MS = 120_000;

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
        args: ["diff", "--name-only", "-z", "--no-renames", before, after],
        cwd: workingDirectory,
      });
      if (names.exit.code !== 0) {
        return none;
      }
      const files = names.stdout.split("\0").filter(Boolean);
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

  /** Adds files, new and deleted ones too, to what the next commit holds. */
  async retainSnapshot(folder: string, key: string, tree: string): Promise<void> {
    if (!/^[a-zA-Z0-9_-]+\/(before|after)$/.test(key) || !/^[0-9a-f]{40,64}$/.test(tree)) {
      throw new GitCommandError("Invalid snapshot reference.");
    }
    await this.#run(folder, ["update-ref", `refs/ai-workbench/turns/${key}`, tree]);
  }

  /** Restores only this turn's paths. The real index, HEAD and branches stay untouched. */
  async undo(folder: string, before: string, after: string): Promise<string[]> {
    for (const tree of [before, after]) {
      if (!/^[0-9a-f]{40,64}$/.test(tree)) throw new GitCommandError("Invalid snapshot.");
      await this.#run(folder, ["cat-file", "-e", `${tree}^{tree}`]);
    }
    const root = (await this.#run(folder, ["rev-parse", "--show-toplevel"])).trim();
    const names = await this.#run(root, ["diff", "--name-only", "-z", "--no-renames", before, after]);
    const files = names.split("\0").filter(Boolean);
    if (files.length === 0) return [];
    const current = await this.snapshot(root);
    if (!current) throw new GitCommandError("The current folder could not be checked; nothing was restored.");
    const changes = (await this.#run(root, ["diff", "--name-only", "-z", "--no-renames", after, current])).split("\0").filter(Boolean);
    const conflicts = files.filter((file) => changes.some((changed) =>
      changed === file || changed.startsWith(`${file}/`) || file.startsWith(`${changed}/`)));
    if (conflicts.length > 0) throw new GitCommandError(`Cannot undo: changed since this turn: ${conflicts.join(", ")}`);
    // Refuse submodules and a redirected parent directory before any write.
    const entries = await this.#run(root, ["ls-tree", "-r", "-z", before]);
    for (const file of files) {
      if (entries.split("\0").some((entry) => entry.startsWith("160000 ") && entry.endsWith(`\t${file}`))) {
        throw new GitCommandError(`Cannot undo submodule: ${file}`);
      }
      const target = resolve(root, file);
      const rel = relative(root, target);
      if (!rel || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new GitCommandError("Unsafe snapshot path.");
      let parent = dirname(target);
      while (parent !== resolve(root)) {
        const stat = await lstat(parent).catch(() => null);
        if (stat?.isSymbolicLink()) throw new GitCommandError(`Cannot undo through a symbolic link: ${file}`);
        parent = dirname(parent);
      }
    }
    const scratch = await mkdtemp(join(tmpdir(), "ai-workbench-undo-"));
    try {
      const env = { GIT_INDEX_FILE: join(scratch, "index") };
      await this.#run(root, ["read-tree", after], { env });
      await this.#run(root, ["--literal-pathspecs", "restore", `--source=${before}`, "--worktree", "--pathspec-from-file=-", "--pathspec-file-nul"], { env, stdin: files.join("\0") + "\0" });
      return files;
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  }

  /** Creates an isolated branch; existing worktrees are reused only on their expected branch. */
  async ensureWorktree(folder: string, target: string, branch: string): Promise<void> {
    const existing = await lstat(target).catch(() => null);
    if (existing) {
      const actual = await this.#run(target, ["symbolic-ref", "--short", "HEAD"]);
      if (actual.trim() !== branch) throw new GitCommandError("The run worktree is on an unexpected branch.");
      return;
    }
    await this.#run(folder, ["rev-parse", "--verify", "HEAD"]);
    await this.#run(folder, ["worktree", "add", "-b", branch, target, "HEAD"]);
  }

  /** Commits the isolated member's working tree only, with an application identity. */
  async checkpointWorktree(folder: string, message: string): Promise<string> {
    await this.#run(folder, ["add", "--all", "--", "."]);
    const changed = await this.#run(folder, ["diff", "--cached", "--name-only"]);
    if (changed.trim()) {
      await this.#run(folder, ["-c", "user.name=AI Workbench", "-c", "user.email=workbench@localhost", "-c", "commit.gpgsign=false", "commit", "--no-verify", "--file=-"], { stdin: message });
    }
    return (await this.#run(folder, ["rev-parse", "HEAD"])).trim();
  }

  /** Merges finished member work into the lead's worktree, retaining real conflict files. */
  async mergeWorktree(folder: string, branch: string): Promise<{ conflicts: string[] }> {
    if (!(await this.status(folder)).clean) throw new GitCommandError("The lead worktree has uncommitted changes.");
    const merge = await this.#transport.exec({ cwd: folder, args: ["-c", "user.name=AI Workbench", "-c", "user.email=workbench@localhost", "-c", "commit.gpgsign=false", "merge", "--no-edit", "--no-ff", branch] });
    const conflicts = (await this.#run(folder, ["diff", "--name-only", "-z", "--diff-filter=U"])).split("\0").filter(Boolean);
    if (merge.exit.code !== 0 && conflicts.length === 0) throw new GitCommandError(merge.exit.stderr || "Worktree merge failed.");
    return { conflicts };
  }

  async stage(workingDirectory: string, paths: readonly string[]): Promise<void> {
    if (paths.length === 0) {
      return;
    }
    await this.#run(workingDirectory, ["add", "--all", "--", ...paths]);
  }

  /** Takes files out of what the next commit holds; their changes stay. */
  async unstage(workingDirectory: string, paths: readonly string[]): Promise<void> {
    if (paths.length === 0) {
      return;
    }
    const born = await this.#transport.exec({ args: ["rev-parse", "--verify", "--quiet", "HEAD"], cwd: workingDirectory });
    // Before the first commit there is nothing to restore from.
    await this.#run(
      workingDirectory,
      born.exit.code === 0
        ? ["restore", "--staged", "--", ...paths]
        : ["rm", "--cached", "-r", "--quiet", "--", ...paths],
    );
  }

  /** What the next commit holds, as a diff; empty when nothing is staged. */
  async stagedDiff(workingDirectory: string, limit = 512 * 1024): Promise<string> {
    const diff = await this.#run(workingDirectory, ["diff", "--cached", "--no-color", "--no-ext-diff"]);
    return diff.length > limit ? diff.slice(0, limit) : diff;
  }

  /** Commits what is staged; the message goes through stdin, never an argument. */
  async commit(workingDirectory: string, message: string): Promise<{ readonly commit: string }> {
    if (message.trim().length === 0) {
      throw new GitCommandError("A commit needs a message.");
    }
    await this.#run(workingDirectory, ["commit", "--file=-", "--cleanup=strip"], { stdin: message });
    const head = await this.#run(workingDirectory, ["rev-parse", "HEAD"]);
    return { commit: head.trim() };
  }

  /** Starts a new branch from where the working tree is, and switches to it. */
  async createBranch(workingDirectory: string, name: string): Promise<void> {
    const valid = await this.#transport.exec({ args: ["check-ref-format", "--branch", name], cwd: workingDirectory });
    if (valid.exit.code !== 0 || name.startsWith("-")) {
      throw new GitCommandError(`"${name}" is not a valid branch name.`);
    }
    await this.#run(workingDirectory, ["switch", "--create", name]);
  }

  /** The URL of a remote, or null when there is none by that name. */
  async remoteUrl(workingDirectory: string, remote = "origin"): Promise<string | null> {
    const found = await this.#transport.exec({ args: ["remote", "get-url", remote], cwd: workingDirectory });
    const url = found.stdout.trim();
    return found.exit.code === 0 && url ? url : null;
  }

  /** Brings in the upstream's commits: fast-forward only, or rebased on top. */
  async pull(
    workingDirectory: string,
    options: { readonly rebase?: boolean; readonly credentials?: GitCredentialSource } = {},
  ): Promise<string> {
    return this.#remote(
      workingDirectory,
      ["pull", options.rebase ? "--rebase" : "--ff-only"],
      options.credentials,
    );
  }

  /** Sends the branch's commits; a branch without upstream gets one on origin. */
  async push(
    workingDirectory: string,
    options: { readonly credentials?: GitCredentialSource } = {},
  ): Promise<string> {
    const status = await this.status(workingDirectory);
    if (!status.isRepository || !status.branch || status.detached) {
      throw new GitCommandError("Only a branch can be pushed.");
    }
    return this.#remote(
      workingDirectory,
      status.upstream ? ["push"] : ["push", "--set-upstream", "origin", status.branch],
      options.credentials,
    );
  }

  /**
   * A command that talks to the remote. With credentials, git asks for them
   * through askpass for this one run and keeps none: no credential helper
   * may store them, nothing is written to .git/config or the remote's URL.
   */
  async #remote(
    workingDirectory: string,
    args: string[],
    credentials: GitCredentialSource | undefined,
  ): Promise<string> {
    const url = await this.remoteUrl(workingDirectory);
    const given = url && credentials ? await credentials(url) : null;
    if (!given) {
      return this.#run(workingDirectory, args, {
        env: { GIT_TERMINAL_PROMPT: "0" },
        timeoutMs: REMOTE_TIMEOUT_MS,
      });
    }
    const askpass = await startAskpass(async (prompt) =>
      /^username/i.test(prompt) ? given.username : /^password/i.test(prompt) ? given.password : null,
    );
    try {
      return await this.#run(workingDirectory, ["-c", "credential.helper=", ...args], {
        env: askpass.env,
        timeoutMs: REMOTE_TIMEOUT_MS,
      });
    } finally {
      await askpass.close();
    }
  }

  /** Runs git and returns its output, or throws with git's own words. */
  async #run(
    workingDirectory: string,
    args: string[],
    options: { readonly env?: Record<string, string>; readonly stdin?: string; readonly timeoutMs?: number } = {},
  ): Promise<string> {
    if (!(await this.isAvailable())) {
      throw new GitCommandError("Git is not installed.");
    }
    const { stdout, exit } = await this.#transport.exec({
      args,
      cwd: workingDirectory,
      ...(options.env ? { env: options.env } : {}),
      ...(options.stdin === undefined ? {} : { stdin: options.stdin }),
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    });
    if (exit.code !== 0) {
      const said = (exit.stderr.trim() || stdout.trim()).split("\n").slice(-6).join("\n");
      throw new GitCommandError(exit.timedOut ? "Git took too long and was stopped." : said || `git ${args[0]} failed`);
    }
    return stdout;
  }
}
