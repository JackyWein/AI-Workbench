import { Terminal } from "@xterm/xterm";

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

/**
 * A terminal in the application's own type and colours. Ctrl+C copies a
 * selection, the way a desktop terminal does; without one it still reaches
 * the program as an interrupt.
 */
export function createTerminal(options: { readonly fontSize: number; readonly lineHeight: number }): Terminal {
  const styles = getComputedStyle(document.documentElement);
  const token = (name: string, fallback: string): string => styles.getPropertyValue(name).trim() || fallback;
  const terminal = new Terminal({
    fontFamily: token("--font-mono", "monospace"),
    fontSize: options.fontSize,
    lineHeight: options.lineHeight,
    cursorBlink: true,
    scrollback: RENDER_SCROLLBACK_LINES,
    allowProposedApi: true,
    theme: {
      background: token("--surface-sunken", "#0c0d0f"),
      foreground: token("--text-primary", "#ecedf0"),
      cursor: token("--accent", "#8c9dff"),
      cursorAccent: token("--surface-sunken", "#0c0d0f"),
      selectionBackground: token("--accent-quiet", "#2a2d33"),
    },
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
