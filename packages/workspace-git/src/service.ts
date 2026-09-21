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
}
