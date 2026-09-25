import type { CommitResult, GitStatus } from "@ai-workbench/shared";
import { suggestCommitMessage } from "./commit-message.js";
import type { GitHubService } from "./github-service.js";
import type { ProviderManager } from "./provider-manager.js";
import { scanDiff } from "./secret-scan.js";

type Credentials = (remoteUrl: string) => Promise<{ username: string; password: string } | null>;

/** The git operations source control needs; the workspace-git package provides them. */
export interface SourceControlGit {
  status(workingDirectory: string): Promise<GitStatus>;
  stage(workingDirectory: string, paths: readonly string[]): Promise<void>;
  unstage(workingDirectory: string, paths: readonly string[]): Promise<void>;
  stagedDiff(workingDirectory: string): Promise<string>;
  commit(workingDirectory: string, message: string): Promise<{ readonly commit: string }>;
  createBranch(workingDirectory: string, name: string): Promise<void>;
  remoteUrl(workingDirectory: string, remote?: string): Promise<string | null>;
  pull(workingDirectory: string, options?: { readonly credentials?: Credentials }): Promise<string>;
  push(workingDirectory: string, options?: { readonly credentials?: Credentials }): Promise<string>;
}

export interface SourceControlOptions {
  readonly git: SourceControlGit;
  readonly github: GitHubService;
  readonly providers: ProviderManager;
  /** Where the model's one-off answers run, away from the person's files. */
  readonly scratchDirectory: string;
}

/**
 * Committing, pulling, pushing and pull requests for a session's folder
 * (FutureFeatures 2). What is about to be committed is checked for likely
 * secrets first; GitHub remotes get the connected account's token through
 * askpass, any other remote whatever git itself would use.
 */
export class SourceControlService {
  readonly #git: SourceControlGit;
  readonly #github: GitHubService;
  readonly #providers: ProviderManager;
  readonly #scratchDirectory: string;

  constructor(options: SourceControlOptions) {
    this.#git = options.git;
    this.#github = options.github;
    this.#providers = options.providers;
    this.#scratchDirectory = options.scratchDirectory;
  }

  stage(folder: string, paths: readonly string[]): Promise<void> {
    return this.#git.stage(folder, paths);
  }

  unstage(folder: string, paths: readonly string[]): Promise<void> {
    return this.#git.unstage(folder, paths);
  }

  /**
   * Commits what is staged — unless it holds a likely secret, in which case
   * nothing is committed and the findings come back. Only when the person
   * looked at them and chose to go on does `allowSecrets` let it through.
   */
  async commit(folder: string, message: string, allowSecrets = false): Promise<CommitResult> {
    const diff = await this.#git.stagedDiff(folder);
    if (diff.trim() === "") {
      throw new Error("Nothing is staged to commit.");
    }
    const findings = scanDiff(diff);
    if (findings.length > 0 && !allowSecrets) {
      return { committed: false, findings };
    }
    const { commit } = await this.#git.commit(folder, message);
    return { committed: true, commit };
  }

  /** A commit message for what is staged, from the session's own tool and model. */
  async suggestMessage(
    folder: string,
    choice: { readonly providerId: string; readonly modelId?: string | undefined; readonly reasoningEffort?: string | undefined },
  ): Promise<string> {
    return suggestCommitMessage(this.#providers, choice, await this.#git.stagedDiff(folder), this.#scratchDirectory);
  }

  createBranch(folder: string, name: string): Promise<void> {
    return this.#git.createBranch(folder, name.trim());
  }

  pull(folder: string): Promise<string> {
    return this.#git.pull(folder, { credentials: this.#credentials });
  }

  push(folder: string): Promise<string> {
    return this.#git.push(folder, { credentials: this.#credentials });
  }

  /** Opens a pull request for the pushed branch on the connected GitHub. */
  async openPullRequest(
    folder: string,
    input: { readonly title: string; readonly body?: string; readonly base?: string },
  ): Promise<{ number: number; url: string }> {
    const status = await this.#git.status(folder);
    if (!status.branch || status.detached) {
      throw new Error("A pull request needs a branch.");
    }
    if (!status.upstream) {
      throw new Error("Push the branch first.");
    }
    const remoteUrl = await this.#git.remoteUrl(folder);
    if (!remoteUrl) {
      throw new Error("This repository has no remote.");
    }
    return this.#github.openPullRequest({
      remoteUrl,
      head: status.branch,
      title: input.title.trim(),
      ...(input.body?.trim() ? { body: input.body.trim() } : {}),
      ...(input.base ? { base: input.base } : {}),
    });
  }

  readonly #credentials: Credentials = (remoteUrl) => this.#github.credentialsFor(remoteUrl);
}
