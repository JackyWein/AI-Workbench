import { type ITheme, Terminal } from "@xterm/xterm";

/**
 * What the session shell and the agent tiles share about showing a terminal:
 * how it looks, how much of its history comes across, and how live output
 * reaches it without a parse per event.
 */

/**
 * Lines kept in the rendered buffer. The process keeps its own full history
 * in the main process; the view only needs a bounded window of it.
 */
const RENDER_SCROLLBACK_LINES = 2000;
/**
 * Characters of history replayed when attaching. A runaway command can leave
 * far more behind than a view can parse without jank, so only the tail comes
 * across.
 */
const MAX_REATTACH_CHARS = 50_000;
/** Output held while a frame or a replay is pending, bounded the same way. */
export const MAX_PENDING_CHARS = 200_000;

/** Keeps the tail of a replay so attaching to a noisy terminal stays fast. */
export function tailForReplay(scrollback: string): string {
  return scrollback.length <= MAX_REATTACH_CHARS
    ? scrollback
    : scrollback.slice(scrollback.length - MAX_REATTACH_CHARS);
}

/** Keeps the newest part of held output within the bound. */
export function boundPending(text: string): string {
  return text.length > MAX_PENDING_CHARS ? text.slice(text.length - MAX_PENDING_CHARS) : text;
}

function token(name: string, fallback: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
}

/** The terminal's colours, from the theme in force. */
function terminalTheme(): ITheme {
  const ansi = (name: string, fallback: string): string => token(`--term-${name}`, fallback);
  return {
    background: token("--terminal-surface", "#0d0e11"),
    foreground: token("--terminal-text", "#c9d1d9"),
    cursor: token("--accent", "#8c9dff"),
    cursorAccent: token("--terminal-surface", "#0d0e11"),
    selectionBackground: token("--accent-quiet", "#2a2d33"),
    black: ansi("black", "#2e3436"),
    red: ansi("red", "#ef6b6b"),
    green: ansi("green", "#6fcf8f"),
    yellow: ansi("yellow", "#e5c35c"),
    blue: ansi("blue", "#6ea8fe"),
    magenta: ansi("magenta", "#c49cf2"),
    cyan: ansi("cyan", "#5bc8c8"),
    white: ansi("white", "#d3d7cf"),
    brightBlack: ansi("bright-black", "#6b707a"),
    brightRed: ansi("bright-red", "#ff8a80"),
    brightGreen: ansi("bright-green", "#8ee6a8"),
    brightYellow: ansi("bright-yellow", "#fce27c"),
    brightBlue: ansi("bright-blue", "#9cc3ff"),
    brightMagenta: ansi("bright-magenta", "#dab8ff"),
    brightCyan: ansi("bright-cyan", "#7fe3e3"),
    brightWhite: ansi("bright-white", "#f4f5f7"),
  };
}

/**
 * Keeps a terminal in the theme in force: its colours and its typeface
 * change with the theme, and `refit` runs once the new face is measured so
 * the rows and columns match it. Runs once at the start too, because a
 * theme's font may still be loading when the terminal opens.
 */
export function followTheme(terminal: Terminal, refit: () => void): () => void {
  let disposed = false;
  const restyle = (): void => {
    terminal.options.theme = terminalTheme();
    const family = token("--font-mono", "monospace");
    const size = terminal.options.fontSize ?? 12;
    void document.fonts
      .load(`${size}px ${family}`)
      .catch(() => [])
      .then(() => {
        if (disposed) {
          return;
        }
        // xterm measures a face when the option changes; the same family
        // set again would keep the fallback's measurements. The generic
        // tail makes the value new without changing what is drawn.
        terminal.options.fontFamily =
          terminal.options.fontFamily === family ? `${family}, monospace` : family;
        requestAnimationFrame(refit);
      });
  };
  const observer = new MutationObserver(restyle);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  restyle();
  return () => {
    disposed = true;
    observer.disconnect();
  };
}

/**
 * A terminal in the application's own type and colours. Ctrl+C copies a
 * selection, the way a desktop terminal does; without one it still reaches
 * the program as an interrupt.
 */
export function createTerminal(options: { readonly fontSize: number; readonly lineHeight: number }): Terminal {
  const terminal = new Terminal({
    fontFamily: token("--font-mono", "monospace"),
    fontSize: options.fontSize,
    lineHeight: options.lineHeight,
    cursorBlink: true,
    scrollback: RENDER_SCROLLBACK_LINES,
    allowProposedApi: true,
    theme: terminalTheme(),
  });
  terminal.attachCustomKeyEventHandler((event) => {
    const copy =
      event.type === "keydown" &&
      (event.ctrlKey || event.metaKey) &&
      event.key.toLowerCase() === "c" &&
      terminal.hasSelection();
    if (copy) {
      void navigator.clipboard.writeText(terminal.getSelection()).catch(() => undefined);
      terminal.clearSelection();
      return false;
    }
    return true;
  });
  return terminal;
}

/**
 * Disposes a terminal once its own pending work has run. xterm 5.5 schedules
 * a measurement when it opens (a timeout) and on a reset (a frame); disposed
 * before those run, it reads a renderer that is gone ("reading
 * 'dimensions'"), which a quick switch between views did.
 */
export function disposeTerminal(terminal: Terminal): void {
  // Out of sight at once, so a terminal opened in the same place (another
  // session's) never shows under it meanwhile.
  terminal.element?.style.setProperty("display", "none");
  setTimeout(() => terminal.dispose(), 50);
}

export interface LiveWriter {
  /** Adds output; it is written with the next frame. */
  push(chunk: string): void;
  /** Writes what is held now, e.g. before a line that must come after it. */
  flush(): void;
  /** Drops what is held and writes nothing more. */
  dispose(): void;
}

/**
 * Live output coalesced to one write per frame, so a fast command cannot
 * schedule a parse per IPC event. Frames stall in hidden windows, so a
 * timeout keeps the stream moving there.
 */
export function liveWriter(terminal: Terminal): LiveWriter {
  let held = "";
  let frame: number | null = null;
  let fallback: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;
  const cancel = (): void => {
    if (frame !== null) {
      cancelAnimationFrame(frame);
      frame = null;
    }
    if (fallback !== null) {
      clearTimeout(fallback);
      fallback = null;
    }
  };
  const flush = (): void => {
    cancel();
    if (held.length === 0 || disposed) {
      held = "";
      return;
    }
    const chunk = held;
    held = "";
    terminal.write(chunk);
  };
  return {
    push(chunk) {
      if (disposed) {
        return;
      }
      held = boundPending(held + chunk);
      frame ??= requestAnimationFrame(flush);
      fallback ??= setTimeout(flush, 100);
    },
    flush,
    dispose() {
      disposed = true;
      cancel();
      held = "";
    },
  };
}
