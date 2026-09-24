import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { Logger } from "@ai-workbench/shared";
import { AsyncQueue, LineAssembler } from "./lines.js";
import { resolveSpawnTarget } from "./windows.js";

export interface CliSpawnOptions {
  readonly executablePath: string;
  readonly args: string[];
  readonly cwd?: string;
  /** Merged over the inherited environment. */
  readonly env?: Record<string, string>;
  /**
   * Written to stdin, which is then closed. Without it stdin is closed at once:
   * some tools wait for more input for as long as stdin stays open.
   */
  readonly stdin?: string;
  /** Keeps stdin open for `write`, for a conversation over stdio. */
  readonly keepStdinOpen?: boolean;
  /** Ends the process after this long, however busy it is. */
  readonly timeoutMs?: number;
  /**
   * Ends the process after this long without a byte on stdout or stderr. A
   * tool that keeps reporting keeps its turn — a long build is work, not a
   * hang — and only one that has gone quiet is stopped.
   */
  readonly idleTimeoutMs?: number;
  /** Grace period between SIGTERM and SIGKILL. */
  readonly killGraceMs?: number;
  readonly logger?: Logger;
}

export interface CliExit {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stderr: string;
  readonly timedOut: boolean;
  readonly cancelled: boolean;
}

export class CliSpawnError extends Error {
  readonly executablePath: string;

  constructor(executablePath: string, cause: unknown) {
    super(
      `Failed to start "${executablePath}": ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
    );
    this.name = "CliSpawnError";
    this.executablePath = executablePath;
  }
}

export interface CliRun {
  /** stdout, one complete line at a time. */
  readonly lines: AsyncIterable<string>;
  /** Resolves when the process has exited. Rejects only if it never started. */
  readonly completion: Promise<CliExit>;
  /** Sends SIGTERM, escalating to SIGKILL after the grace period. */
  cancel(): void;
  write(input: string): void;
}

/**
 * Runs a CLI without a shell (spec §12). Arguments are always passed as an
 * array, so no quoting or escaping of user input is involved and there is no
 * command string that could be injected into.
 */
export function startCli(options: CliSpawnOptions): CliRun {
  const queue = new AsyncQueue<string>();
  const assembler = new LineAssembler();
  const stderrChunks: string[] = [];

  let child: ChildProcessWithoutNullStreams;
  try {
    const target = resolveSpawnTarget(options.executablePath, options.args);
    child = spawn(target.command, target.args, {
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      // PWD follows the folder the tool runs in, as a shell would set it.
      // Inherited, it names the folder the application was started from, and
      // tools that prefer PWD over their real working folder (OpenCode's
      // `run` and terminal interface do) then work there instead.
      env: {
        ...process.env,
        ...options.env,
        ...target.env,
        ...(options.cwd === undefined ? {} : { PWD: options.cwd }),
      },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      windowsVerbatimArguments: target.windowsVerbatimArguments,
    });
  } catch (error) {
    const failure = new CliSpawnError(options.executablePath, error);
    queue.fail(failure);
    return {
      lines: queue,
      completion: Promise.reject(failure),
      cancel: () => {},
      write: () => {},
    };
  }

  let cancelled = false;
  let timedOut = false;
  let killTimer: NodeJS.Timeout | null = null;
  let timeoutTimer: NodeJS.Timeout | null = null;

  const terminate = (): void => {
    if (child.exitCode !== null || child.signalCode !== null) {
      return;
    }
    child.kill("SIGTERM");
    killTimer ??= setTimeout(() => {
      // The process ignored SIGTERM; stop waiting for it.
      child.kill("SIGKILL");
    }, options.killGraceMs ?? 2000);
    killTimer.unref?.();
  };

  const cancel = (): void => {
    cancelled = true;
    terminate();
  };

  if (options.timeoutMs !== undefined && options.timeoutMs > 0) {
    timeoutTimer = setTimeout(() => {
      timedOut = true;
      terminate();
    }, options.timeoutMs);
    timeoutTimer.unref?.();
  }

  let idleTimer: NodeJS.Timeout | null = null;
  const idleMs = options.idleTimeoutMs;
  const stillAlive = (): void => {
    if (idleMs === undefined || idleMs <= 0) {
      return;
    }
    if (idleTimer) {
      clearTimeout(idleTimer);
    }
    idleTimer = setTimeout(() => {
      timedOut = true;
      terminate();
    }, idleMs);
    idleTimer.unref?.();
  };
  stillAlive();

  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stillAlive();
    for (const line of assembler.push(chunk)) {
      queue.push(line);
    }
  });

  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stillAlive();
    stderrChunks.push(chunk);
    // stderr is kept for error messages only; it never becomes model output.
    if (stderrChunks.length > 500) {
      stderrChunks.splice(0, stderrChunks.length - 500);
    }
  });

  const completion = new Promise<CliExit>((resolve, reject) => {
    child.once("error", (error) => {
      const failure = new CliSpawnError(options.executablePath, error);
      queue.fail(failure);
      reject(failure);
    });

    child.once("close", (code, signal) => {
      if (killTimer) {
        clearTimeout(killTimer);
      }
      if (timeoutTimer) {
        clearTimeout(timeoutTimer);
      }
      if (idleTimer) {
        clearTimeout(idleTimer);
      }
      for (const line of assembler.flush()) {
        queue.push(line);
      }
      queue.close();
      resolve({
        code,
        signal,
        stderr: stderrChunks.join(""),
        timedOut,
        cancelled,
      });
    });
  });

  child.stdin.on("error", () => {
    // A CLI may exit before reading stdin; that is not our failure.
  });
  if (options.stdin !== undefined) {
    child.stdin.end(options.stdin);
  } else if (!options.keepStdinOpen) {
    child.stdin.end();
  }

  return {
    lines: queue,
    completion,
    cancel,
    write: (input: string) => {
      if (child.stdin.writable) {
        child.stdin.write(input);
      }
    },
  };
}

/** Runs a CLI to completion and buffers its output. For probes, not answers. */
export async function execCli(
  options: CliSpawnOptions,
): Promise<{ stdout: string; exit: CliExit }> {
  const run = startCli(options);
  const collected: string[] = [];
  for await (const line of run.lines) {
    collected.push(line);
  }
  const exit = await run.completion;
  return { stdout: collected.join("\n"), exit };
}
