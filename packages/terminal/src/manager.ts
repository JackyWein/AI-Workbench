import { randomUUID } from "node:crypto";
import { spawn, type IPty } from "node-pty";
import type { Logger } from "@ai-workbench/shared";

export interface TerminalInfo {
  readonly id: string;
  readonly sessionId: string;
  readonly cwd: string;
  readonly shell: string;
  readonly cols: number;
  readonly rows: number;
}

export interface CreateTerminalOptions {
  readonly sessionId: string;
  /** Already validated against the session's workspace by the caller. */
  readonly cwd: string;
  readonly cols?: number;
  readonly rows?: number;
  readonly shell?: string;
  /**
   * A program to run instead of the shell, with its arguments — how a tool's
   * own interactive interface runs in a terminal. Already resolved to an
   * executable by the caller; nothing here goes through a shell.
   */
  readonly command?: {
    readonly file: string;
    /** An array, or one command line that is already quoted for cmd.exe. */
    readonly args: readonly string[] | string;
  };
  readonly env?: Record<string, string>;
}

export interface TerminalManagerOptions {
  readonly logger: Logger;
  readonly onData: (terminalId: string, chunk: string) => void;
  readonly onExit: (terminalId: string, exitCode: number) => void;
  /** Maximum number of live terminals, to bound resource use. */
  readonly maxTerminals?: number;
  /** Characters of output kept per terminal for reattachment. */
  readonly scrollbackLimit?: number;
}

interface TerminalState {
  readonly info: TerminalInfo;
  readonly pty: IPty;
  cols: number;
  rows: number;
  /**
   * Recent output, so a view that was closed and reopened can rejoin an
   * already running shell instead of showing an empty screen.
   */
  scrollback: string;
}

export class TerminalLimitError extends Error {
  constructor(limit: number) {
    super(`At most ${limit} terminals can be open at once`);
    this.name = "TerminalLimitError";
  }
}

export class TerminalNotFoundError extends Error {
  constructor(id: string) {
    super(`Terminal "${id}" does not exist`);
    this.name = "TerminalNotFoundError";
  }
}

/**
 * Real terminals backed by node-pty (spec §26). A terminal belongs to a session
 * and starts in its working directory; its lifetime is independent of whether
 * the UI is showing it, so a long command keeps running when the tab changes.
 */
export class TerminalManager {
  readonly #terminals = new Map<string, TerminalState>();
  readonly #options: TerminalManagerOptions;
  readonly #logger: Logger;
  readonly #maxTerminals: number;
  readonly #scrollbackLimit: number;

  constructor(options: TerminalManagerOptions) {
    this.#options = options;
    this.#logger = options.logger.child("TERMINAL");
    // Agent terminals and shells share the budget; a grid of agents per
    // workspace needs room without letting a runaway loop open hundreds.
    this.#maxTerminals = options.maxTerminals ?? 24;
    this.#scrollbackLimit = options.scrollbackLimit ?? 200_000;
  }

  create(options: CreateTerminalOptions): TerminalInfo {
    if (this.#terminals.size >= this.#maxTerminals) {
      throw new TerminalLimitError(this.#maxTerminals);
    }

    const shell = options.command?.file ?? options.shell ?? defaultShell();
    const cols = options.cols ?? 80;
    const rows = options.rows ?? 24;
    const id = randomUUID();

    const args = options.command?.args ?? [];
    const pty = spawn(shell, typeof args === "string" ? args : [...args], {
      name: "xterm-256color",
      cols,
      rows,
      cwd: options.cwd,
      env: {
        ...(process.env as Record<string, string>),
        ...options.env,
        TERM: "xterm-256color",
      },
    });

    const info: TerminalInfo = {
      id,
      sessionId: options.sessionId,
      cwd: options.cwd,
      shell,
      cols,
      rows,
    };
    const state: TerminalState = { info, pty, cols, rows, scrollback: "" };
    this.#terminals.set(id, state);

    pty.onData((chunk) => {
      state.scrollback = trimScrollback(
        state.scrollback + chunk,
        this.#scrollbackLimit,
      );
      this.#options.onData(id, chunk);
    });
    pty.onExit(({ exitCode }) => {
      this.#terminals.delete(id);
      this.#logger.debug("Terminal exited", { terminalId: id, exitCode });
      this.#options.onExit(id, exitCode);
    });

    this.#logger.info("Terminal started", {
      terminalId: id,
      sessionId: options.sessionId,
      shell,
    });
    return info;
  }

  /** Output kept for a terminal, used when a view reattaches to it. */
  scrollback(id: string): string {
    return this.#terminals.get(id)?.scrollback ?? "";
  }

  /** Returns the session's terminal, starting one when there is none yet. */
  attach(options: CreateTerminalOptions): { info: TerminalInfo; scrollback: string } {
    const existing = this.list(options.sessionId)[0];
    if (existing) {
      return { info: existing, scrollback: this.scrollback(existing.id) };
    }
    return { info: this.create(options), scrollback: "" };
  }

  write(id: string, data: string): void {
    this.#require(id).pty.write(data);
  }

  resize(id: string, cols: number, rows: number): void {
    const state = this.#require(id);
    const safeCols = Math.max(1, Math.min(1000, Math.floor(cols)));
    const safeRows = Math.max(1, Math.min(1000, Math.floor(rows)));
    if (state.cols === safeCols && state.rows === safeRows) {
      return;
    }
    state.cols = safeCols;
    state.rows = safeRows;
    state.pty.resize(safeCols, safeRows);
  }

  close(id: string): boolean {
    const state = this.#terminals.get(id);
    if (!state) {
      return false;
    }
    this.#terminals.delete(id);
    try {
      state.pty.kill();
    } catch (error) {
      this.#logger.warn("Terminal could not be killed", {
        terminalId: id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return true;
  }

  list(sessionId?: string): TerminalInfo[] {
    return [...this.#terminals.values()]
      .map((state) => ({ ...state.info, cols: state.cols, rows: state.rows }))
      .filter((info) => sessionId === undefined || info.sessionId === sessionId);
  }

  has(id: string): boolean {
    return this.#terminals.has(id);
  }

  /** Closes every terminal; used when a session is deleted or the app quits. */
  closeAll(sessionId?: string): void {
    for (const info of this.list(sessionId)) {
      this.close(info.id);
    }
  }

  #require(id: string): TerminalState {
    const state = this.#terminals.get(id);
    if (!state) {
      throw new TerminalNotFoundError(id);
    }
    return state;
  }
}

/** Keeps the buffer bounded, cutting at the front so the newest output stays. */
function trimScrollback(value: string, limit: number): string {
  return value.length <= limit ? value : value.slice(value.length - limit);
}

function defaultShell(): string {
  if (process.platform === "win32") {
    return process.env["COMSPEC"] ?? "powershell.exe";
  }
  return process.env["SHELL"] ?? "/bin/bash";
}
