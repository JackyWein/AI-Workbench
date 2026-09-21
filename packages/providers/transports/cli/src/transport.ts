import type { Logger } from "@ai-workbench/shared";
import { ProviderError } from "@ai-workbench/provider-base";
import { findExecutable, probeVersion, type VersionProbe } from "./discovery.js";
import { execCli, startCli, type CliExit, type CliRun } from "./process.js";

export interface CliTransportOptions {
  /** Executable name looked up on PATH, e.g. "some-cli". */
  readonly command: string;
  readonly configuredPath?: string | undefined;
  readonly baseArgs?: string[];
  readonly env?: Record<string, string>;
  readonly defaultTimeoutMs?: number;
  readonly logger: Logger;
}

export interface CliInvocation {
  readonly args: string[];
  readonly cwd?: string | undefined;
  readonly stdin?: string | undefined;
  readonly timeoutMs?: number | undefined;
}

/**
 * Reusable CLI transport (spec §12). It owns executable resolution, argument
 * assembly, environment, working directory, cancellation, timeouts, exit
 * handling and health checks, so an adapter only has to describe how its CLI is
 * invoked and how its output is shaped.
 */
export class CliTransport {
  readonly #options: CliTransportOptions;
  readonly #logger: Logger;
  #resolvedPath: string | null = null;

  constructor(options: CliTransportOptions) {
    this.#options = options;
    this.#logger = options.logger.child("PROCESS");
  }

  /** Resolves and caches the executable path. Null when it is not installed. */
  async locate(refresh = false): Promise<string | null> {
    if (this.#resolvedPath !== null && !refresh) {
      return this.#resolvedPath;
    }
    const found = await findExecutable(this.#options.command, {
      configuredPath: this.#options.configuredPath,
    });
    this.#resolvedPath = found?.path ?? null;
    return this.#resolvedPath;
  }

  async version(args: string[] = ["--version"]): Promise<VersionProbe | null> {
    const executablePath = await this.locate();
    if (!executablePath) {
      return null;
    }
    return probeVersion(executablePath, args);
  }

  /** A cheap liveness probe: does the executable run at all? */
  async healthCheck(args: string[] = ["--version"]): Promise<boolean> {
    const probe = await this.version(args);
    return probe?.ok ?? false;
  }

  async exec(invocation: CliInvocation): Promise<{ stdout: string; exit: CliExit }> {
    const executablePath = await this.#requirePath();
    return execCli({
      executablePath,
      args: [...(this.#options.baseArgs ?? []), ...invocation.args],
      ...(invocation.cwd === undefined ? {} : { cwd: invocation.cwd }),
      ...(this.#options.env === undefined ? {} : { env: this.#options.env }),
      ...(invocation.stdin === undefined ? {} : { stdin: invocation.stdin }),
      timeoutMs: invocation.timeoutMs ?? this.#options.defaultTimeoutMs ?? 30_000,
    });
  }

  async start(invocation: CliInvocation): Promise<CliRun> {
    const executablePath = await this.#requirePath();
    const args = [...(this.#options.baseArgs ?? []), ...invocation.args];

    this.#logger.debug("Starting CLI", {
      executablePath,
      // Arguments are logged for diagnosis; they never contain credentials,
      // which are passed through the environment or the CLI's own store.
      argumentCount: args.length,
    });

    return startCli({
      executablePath,
      args,
      ...(invocation.cwd === undefined ? {} : { cwd: invocation.cwd }),
      ...(this.#options.env === undefined ? {} : { env: this.#options.env }),
      ...(invocation.stdin === undefined ? {} : { stdin: invocation.stdin }),
      ...(invocation.timeoutMs === undefined
        ? this.#options.defaultTimeoutMs === undefined
          ? {}
          : { timeoutMs: this.#options.defaultTimeoutMs }
        : { timeoutMs: invocation.timeoutMs }),
      logger: this.#logger,
    });
  }

  async #requirePath(): Promise<string> {
    const executablePath = await this.locate();
    if (!executablePath) {
      throw new ProviderError(
        "notInstalled",
        `"${this.#options.command}" was not found`,
        {
          detail:
            "Install the command line tool, or set its path in the provider settings.",
        },
      );
    }
    return executablePath;
  }
}
