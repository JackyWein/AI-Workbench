import { Terminal } from "@xterm/headless";

/** What a terminal shows right now, as text, and how it wants its keys. */
export interface ScreenSnapshot {
  /**
   * The visible lines, top to bottom, without trailing spaces. A line the
   * terminal wrapped because it ran past the right edge is one line here.
   */
  readonly lines: readonly string[];
  /**
   * Whether the program switched the arrow keys to "application" mode, in
   * which a terminal sends ESC O A instead of ESC [ A for the up arrow.
   */
  readonly applicationCursorKeys: boolean;
}

/**
 * A terminal's screen, kept in the main process the way the person's own
 * view draws it: every byte the program writes goes through the same
 * emulator (xterm.js, without a display), so cursor movement, redraws and
 * wrapping end up exactly as on screen. Only the visible rows are kept.
 */
export class TerminalScreen {
  readonly #terminal: Terminal;
  #pending = 0;

  constructor(cols: number, rows: number) {
    this.#terminal = new Terminal({ cols, rows, scrollback: 0, allowProposedApi: true });
  }

  write(chunk: string): void {
    this.#pending += 1;
    this.#terminal.write(chunk, () => {
      this.#pending -= 1;
    });
  }

  /** Resolves once everything written so far is on the screen. */
  settled(): Promise<void> {
    if (this.#pending === 0) {
      return Promise.resolve();
    }
    return new Promise((resolve) => this.#terminal.write("", () => resolve()));
  }

  resize(cols: number, rows: number): void {
    this.#terminal.resize(cols, rows);
  }

  snapshot(): ScreenSnapshot {
    const buffer = this.#terminal.buffer.active;
    const lines: string[] = [];
    for (let row = 0; row < this.#terminal.rows; row += 1) {
      const line = buffer.getLine(buffer.viewportY + row);
      const text = line?.translateToString(true) ?? "";
      if (line?.isWrapped && lines.length > 0) {
        lines[lines.length - 1] += text;
      } else {
        lines.push(text);
      }
    }
    return { lines, applicationCursorKeys: this.#terminal.modes.applicationCursorKeysMode };
  }

  dispose(): void {
    this.#terminal.dispose();
  }
}
