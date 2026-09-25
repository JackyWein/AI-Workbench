import { randomUUID } from "node:crypto";
import { spawn, type IPty } from "node-pty";
import type { Logger } from "@ai-workbench/shared";
import { arrowKey, detectPrompt, type ScreenPrompt } from "./prompt.js";
import { TerminalScreen } from "./screen.js";

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
  /**
   * Characters of scrollback handed out per reattach. A runaway command can
   * leave far more behind than a view can replay without jank, so only the
   * tail crosses IPC; the rest stays available in the live buffer.
   */
  readonly reattachLimit?: number;
}

interface TerminalState {
  readonly info: TerminalInfo;
  readonly pty: IPty;
  cols: number;
  rows: number;
  /**
   * Recent output, so a view that was closed and reopened can rejoin an
   * already running shell instead of showing an empty screen. Kept as chunks
   * so a fast command does not copy the whole buffer on every data event.
   */
  scrollback: string[];
  /** The window title the program last set (OSC 0 or 2), if any. */
  title: string | null;
  /** When the program last wrote anything. */
  lastOutputAt: number;
  /** What the terminal shows, kept as the person's view draws it. */
  readonly screen: TerminalScreen;
  scrollbackChars: number;
  readonly disposables: Array<{ dispose(): void }>;
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
  readonly #reattachLimit: number;

  constructor(options: TerminalManagerOptions) {
    this.#options = options;
    this.#logger = options.logger.child("TERMINAL");
    // Agent terminals and shells share the budget; a grid of agents per
    // workspace needs room without letting a runaway loop open hundreds.
    this.#maxTerminals = options.maxTerminals ?? 24;
    this.#scrollbackLimit = options.scrollbackLimit ?? 200_000;
    this.#reattachLimit = options.reattachLimit ?? 50_000;
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
        // The terminal's own folder, not the one the application was started
        // from: programs that read PWD before their working folder (OpenCode
        // does) would otherwise work in the application's folder.
        ...(options.cwd ? { PWD: options.cwd } : {}),
      },
    });

    guardWindowsKill(pty);

    const info: TerminalInfo = {
      id,
      sessionId: options.sessionId,
      cwd: options.cwd,
      shell,
      cols,
      rows,
    };
    const state: TerminalState = {
      info,
      pty,
      cols,
      rows,
      scrollback: [],
      scrollbackChars: 0,
      title: null,
      lastOutputAt: Date.now(),
      screen: new TerminalScreen(cols, rows),
      disposables: [],
    };
    this.#terminals.set(id, state);
    state.disposables.push({ dispose: () => state.screen.dispose() });

    state.disposables.push(
      pty.onData((chunk) => {
        state.lastOutputAt = Date.now();
        state.screen.write(chunk);
        const title = lastTitle(chunk);
        if (title !== null) {
          state.title = saysSomething(title) ? title : null;
        }
        appendScrollback(state, chunk, this.#scrollbackLimit);
        this.#options.onData(id, chunk);
      }),
    );
    state.disposables.push(
      pty.onExit(({ exitCode }) => {
        for (const disposable of state.disposables) {
          try {
            disposable.dispose();
          } catch {
            // Disposal must not break exit reporting.
          }
        }
        this.#terminals.delete(id);
        this.#logger.debug("Terminal exited", { terminalId: id, exitCode });
        this.#options.onExit(id, exitCode);
      }),
    );

    this.#logger.info("Terminal started", {
      terminalId: id,
      sessionId: options.sessionId,
      shell,
    });
    return info;
  }

  /**
   * The tail of the output kept for a terminal, used when a view reattaches
   * to it. Bounded by the reattach limit so a noisy terminal does not push
   * its whole history across IPC on every attach.
   */
  scrollback(id: string): string {
    const state = this.#terminals.get(id);
    if (!state) {
      return "";
    }
    const full = state.scrollback.join("");
    return full.length <= this.#reattachLimit
      ? full
      : full.slice(full.length - this.#reattachLimit);
  }

  /**
   * What a terminal's program says about itself without being asked: the
   * window title it set (tools like Claude Code put their current task
   * there) and when it last wrote anything. Null for an unknown terminal.
   */
  activity(id: string): { title: string | null; lastOutputAt: Date } | null {
    const state = this.#terminals.get(id);
    return state ? { title: state.title, lastOutputAt: new Date(state.lastOutputAt) } : null;
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
    state.screen.resize(safeCols, safeRows);
  }

  /**
   * The dialog the terminal's program waits on — a question with numbered
   * options, one of them marked — read from its screen as the person sees
   * it. Null when the screen shows none, or the terminal is gone.
   */
  async prompt(id: string): Promise<ScreenPrompt | null> {
    const state = this.#terminals.get(id);
    if (!state) {
      return null;
    }
    await state.screen.settled();
    return detectPrompt(state.screen.snapshot().lines);
  }

  /**
   * Picks option \`index\` of the dialog on screen the way the person would:
   * arrow keys until the screen shows that option marked, then Enter. Enter
   * is never pressed on anything but the option asked for — when the dialog
   * changed, is gone, or its marker does not follow, nothing is chosen and
   * the answer is false.
   */
  async choose(id: string, fingerprint: string, index: number): Promise<boolean> {
    const state = this.#terminals.get(id);
    if (!state) {
      return false;
    }
    const read = async (): Promise<{ prompt: ScreenPrompt | null; applicationCursorKeys: boolean }> => {
      await state.screen.settled();
      const snapshot = state.screen.snapshot();
      return { prompt: detectPrompt(snapshot.lines), applicationCursorKeys: snapshot.applicationCursorKeys };
    };
    let current = await read();
    if (
      !current.prompt ||
      current.prompt.fingerprint !== fingerprint ||
      index < 0 ||
      index >= current.prompt.options.length
    ) {
      return false;
    }
    for (let step = 0; current.prompt?.selected !== index; step += 1) {
      const from = current.prompt?.selected ?? -1;
      if (step >= 12 || from === -1 || !this.#terminals.has(id)) {
        return false;
      }
      state.pty.write(arrowKey(index > from ? "down" : "up", current.applicationCursorKeys));
      // The program redraws its dialog; wait until the marker has moved.
      const until = Date.now() + 1500;
      do {
        await new Promise((resolve) => setTimeout(resolve, 40));
        current = await read();
      } while (
        Date.now() < until &&
        current.prompt?.fingerprint === fingerprint &&
        current.prompt.selected === from
      );
      if (current.prompt?.fingerprint !== fingerprint || current.prompt.selected === from) {
        return false;
      }
    }
    state.pty.write("\r");
    this.#logger.info("Chose an option of a terminal program's dialog", { terminalId: id, option: index + 1 });
    return true;
  }

  close(id: string): boolean {
    const state = this.#terminals.get(id);
    if (!state) {
      return false;
    }
    this.#terminals.delete(id);
    for (const disposable of state.disposables) {
      try {
        disposable.dispose();
      } catch {
        // Disposal must not break close.
      }
    }
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

/** How long node-pty waits for its console helper before it gives up. */
const CONSOLE_LIST_TIMEOUT_MS = 5_000;

/**
 * Closing a terminal on Windows, node-pty asks a helper process for every
 * process attached to the terminal's console and ends them. When the helper
 * cannot attach — the program in the terminal has just ended by itself — it
 * fails, and node-pty ends the terminal's original process id after five
 * seconds anyway. By then Windows may have handed that id to an unrelated
 * process, which is what dies. A helper that timed out is taken to mean
 * what it does mean: nothing is left to end.
 */
export function guardWindowsKill(pty: IPty, platform: NodeJS.Platform = process.platform): void {
  if (platform !== "win32") {
    return;
  }
  const agent = (pty as unknown as { _agent?: { _getConsoleProcessList?: () => Promise<number[]> } })._agent;
  const original = agent?._getConsoleProcessList;
  if (!agent || typeof original !== "function") {
    return;
  }
  agent._getConsoleProcessList = async (): Promise<number[]> => {
    const started = Date.now();
    const list = await original.call(agent);
    return Date.now() - started >= CONSOLE_LIST_TIMEOUT_MS - 100 ? [] : list;
  };
}

/**
 * Appends output in amortized O(1), dropping whole chunks from the front so
 * the newest output stays within the limit without copying the buffer.
 */
function appendScrollback(state: TerminalState, chunk: string, limit: number): void {
  if (chunk.length === 0) {
    return;
  }
  if (chunk.length >= limit) {
    state.scrollback = [chunk.slice(chunk.length - limit)];
    state.scrollbackChars = state.scrollback[0]?.length ?? 0;
    return;
  }
  state.scrollback.push(chunk);
  state.scrollbackChars += chunk.length;
  let overflow = state.scrollbackChars - limit;
  while (overflow > 0 && state.scrollback.length > 0) {
    const first = state.scrollback[0] ?? "";
    if (first.length <= overflow) {
      state.scrollback.shift();
      state.scrollbackChars -= first.length;
      overflow -= first.length;
    } else {
      state.scrollback[0] = first.slice(overflow);
      state.scrollbackChars -= overflow;
      overflow = 0;
    }
  }
}

function defaultShell(): string {
  if (process.platform === "win32") {
    return process.env["COMSPEC"] ?? "powershell.exe";
  }
  return process.env["SHELL"] ?? "/bin/bash";
}

/**
 * Whether a window title says anything about the work. On Windows the
 * console names the window after the program's file (C:\\Windows\\system32\\cmd.exe),
 * which says nothing a person wants to read where the work is described.
 */
export function saysSomething(title: string): boolean {
  const trimmed = title.trim();
  return !(
    trimmed === "" ||
    /^[a-z]:[\\/]/i.test(trimmed) ||
    /^\\\\/.test(trimmed) ||
    /\.(exe|cmd|bat|com|ps1)$/i.test(trimmed)
  );
}

/**
 * The last window title a chunk of output sets: OSC 0 or 2, ended by BEL or
 * ST. Null when the chunk sets none. Control characters are dropped and the
 * result is bounded, since it is shown elsewhere as plain text.
 */
export function lastTitle(chunk: string): string | null {
  let title: string | null = null;
  // eslint-disable-next-line no-control-regex
  const pattern = /\x1b\][02];([^\x07\x1b]*)(?:\x07|\x1b\\)/g;
  for (let match = pattern.exec(chunk); match; match = pattern.exec(chunk)) {
    // eslint-disable-next-line no-control-regex
    title = (match[1] ?? "").replace(/[\x00-\x1f\x7f]/g, "").trim().slice(0, 160);
  }
  return title;
}
