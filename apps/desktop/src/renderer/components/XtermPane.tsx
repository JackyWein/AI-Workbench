import { type JSX, useEffect, useRef, useState } from "react";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { invoke } from "../lib/client.js";

interface XtermPaneProps {
  /** The live terminal to show; null shows an empty, inert surface. */
  readonly terminalId: string | null;
  /** Moves keyboard focus into the terminal when it becomes true. */
  readonly focused?: boolean;
  readonly onFocus?: () => void;
  readonly fontSize?: number;
}

/**
 * Lines kept in the rendered buffer. The process keeps its own full history
 * in the main process; the view only needs a bounded window of it.
 */
const RENDER_SCROLLBACK_LINES = 2000;
/**
 * Characters of history replayed when attaching. A runaway command can leave
 * far more behind than a view can parse without jank, so only the tail comes
 * across (the manager keeps the rest for a later page-in, if ever needed).
 */
const MAX_REATTACH_CHARS = 50_000;
/** Live output held while a replay is still on its way, bounded the same way. */
const MAX_PENDING_CHARS = 200_000;

/** Keeps the tail of a replay so attaching to a noisy terminal stays fast. */
function tailForReplay(scrollback: string): string {
  return scrollback.length <= MAX_REATTACH_CHARS
    ? scrollback
    : scrollback.slice(scrollback.length - MAX_REATTACH_CHARS);
}

/**
 * One live terminal, attached by id. The process belongs to the main process
 * and keeps running when this view goes away (spec §26, §91); coming back
 * replays what it printed in the meantime.
 */
export function XtermPane({
  terminalId,
  focused = false,
  onFocus,
  fontSize = 12,
}: XtermPaneProps): JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const idRef = useRef<string | null>(terminalId);
  const onFocusRef = useRef(onFocus);
  onFocusRef.current = onFocus;

  // One xterm per pane, reused across processes of the same tile.
  // The initial size is captured once; later changes arrive through
  // `terminal.options` below instead of rebuilding the terminal.
  const initialFontSize = useRef(fontSize).current;
  useEffect(() => {
    const container = containerRef.current;
    if (!container) {
      return;
    }
    const styles = getComputedStyle(document.documentElement);
    const token = (name: string, fallback: string): string =>
      styles.getPropertyValue(name).trim() || fallback;

    const terminal = new Terminal({
      fontFamily: token("--font-mono", "monospace"),
      fontSize: initialFontSize,
      lineHeight: 1.25,
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
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(container);
    terminalRef.current = terminal;
    fitRef.current = fit;

    // Copy a selection with Ctrl+C, the way a desktop terminal does; without a
    // selection Ctrl+C still reaches the program as an interrupt.
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

    const input = terminal.onData((data) => {
      const id = idRef.current;
      if (id) {
        void invoke("terminal.write", { terminalId: id, data }).catch(() => undefined);
      }
    });
    const focusIn = (): void => onFocusRef.current?.();
    container.addEventListener("focusin", focusIn);

    const resize = (): void => {
      if (container.clientWidth === 0 || container.clientHeight === 0) {
        return;
      }
      try {
        fit.fit();
      } catch {
        return;
      }
      const id = idRef.current;
      if (id) {
        void invoke("terminal.resize", {
          terminalId: id,
          cols: terminal.cols,
          rows: terminal.rows,
        }).catch(() => undefined);
      }
    };
    const observer = new ResizeObserver(() => requestAnimationFrame(resize));
    observer.observe(container);

    return () => {
      observer.disconnect();
      container.removeEventListener("focusin", focusIn);
      input.dispose();
      terminalRef.current = null;
      fitRef.current = null;
      // xterm 5.5 schedules a measurement when it opens (a timeout) and on a
      // reset (a frame). Disposed before those run, it reads a renderer that
      // is gone ("reading 'dimensions'"), which a quick switch between the
      // conversation and the agents did. Its own pending work runs first.
      setTimeout(() => terminal.dispose(), 50);
    };
    // Created once: a font size change must not rebuild the terminal and
    // lose its buffer; it arrives through `terminal.options` below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // A size change updates the live terminal in place and refits its rows.
  useEffect(() => {
    const terminal = terminalRef.current;
    if (!terminal || terminal.options.fontSize === fontSize) {
      return;
    }
    terminal.options.fontSize = fontSize;
    try {
      fitRef.current?.fit();
    } catch {
      // Not laid out yet; the resize observer catches up.
    }
  }, [fontSize]);

  // Attach to the current process of the tile.
  useEffect(() => {
    const terminal = terminalRef.current;
    idRef.current = terminalId;
    if (!terminal) {
      return;
    }
    terminal.reset();
    if (!terminalId) {
      return;
    }

    let disposed = false;
    let pending = "";
    let replayed = false;
    const timeouts = new Set<ReturnType<typeof setTimeout>>();
    // Live output is coalesced to one write per frame so a fast command
    // cannot schedule a parse per IPC event. rAF stalls in hidden windows,
    // so a timeout fallback keeps the stream moving (like event-stream).
    let live = "";
    let liveFrame: number | null = null;
    let liveFallback: ReturnType<typeof setTimeout> | null = null;
    const flushLive = (): void => {
      liveFrame = null;
      if (liveFallback !== null) {
        clearTimeout(liveFallback);
        liveFallback = null;
      }
      if (live.length === 0 || disposed) {
        live = "";
        return;
      }
      const chunk = live;
      live = "";
      terminal.write(chunk);
    };
    const scheduleLive = (chunk: string): void => {
      live += chunk;
      if (live.length > MAX_PENDING_CHARS) {
        live = live.slice(live.length - MAX_PENDING_CHARS);
      }
      liveFrame ??= requestAnimationFrame(flushLive);
      liveFallback ??= setTimeout(() => {
        liveFallback = null;
        if (liveFrame !== null) {
          cancelAnimationFrame(liveFrame);
        }
        flushLive();
      }, 100);
    };

    const detach = window.workbench.onTerminalEvent((event) => {
      if (event.terminalId !== terminalId) {
        return;
      }
      if (event.type === "data") {
        // Output that arrives while the scrollback is still on its way is
        // held back, so it cannot land before the history it follows.
        if (replayed) {
          scheduleLive(event.chunk);
        } else {
          pending += event.chunk;
          if (pending.length > MAX_PENDING_CHARS) {
            pending = pending.slice(pending.length - MAX_PENDING_CHARS);
          }
        }
      } else {
        if (liveFrame !== null) {
          cancelAnimationFrame(liveFrame);
          flushLive();
        }
        terminal.write(`\r\n\x1b[2m[process exited with code ${event.exitCode}]\x1b[0m\r\n`);
      }
    });

    void invoke("terminal.reattach", { terminalId })
      .then(({ exists, scrollback }) => {
        if (disposed) {
          return;
        }
        if (!exists) {
          terminal.write(`\r\n\x1b[2m[process ended]\x1b[0m\r\n`);
          replayed = true;
          return;
        }
        if (scrollback) {
          terminal.write(tailForReplay(scrollback));
        }
        if (pending) {
          terminal.write(pending);
          pending = "";
        }
        replayed = true;
        try {
          fitRef.current?.fit();
        } catch {
          // Not laid out yet; the resize observer catches up.
        }
        void invoke("terminal.resize", {
          terminalId,
          cols: terminal.cols,
          rows: terminal.rows,
        }).catch(() => undefined);
        // Layout often settles a tick after the pane appears (workspace
        // switch, panel open): fit once more so the pty matches what xterm
        // actually renders instead of a mid-animation size.
        const settle = setTimeout(() => {
          if (disposed || idRef.current !== terminalId) {
            return;
          }
          try {
            fitRef.current?.fit();
          } catch {
            return;
          }
          void invoke("terminal.resize", {
            terminalId,
            cols: terminal.cols,
            rows: terminal.rows,
          }).catch(() => undefined);
        }, 300);
        timeouts.add(settle);
      })
      .catch(() => {
        replayed = true;
      });

    return () => {
      disposed = true;
      for (const timeout of timeouts) {
        clearTimeout(timeout);
      }
      timeouts.clear();
      if (liveFrame !== null) {
        cancelAnimationFrame(liveFrame);
        liveFrame = null;
      }
      if (liveFallback !== null) {
        clearTimeout(liveFallback);
        liveFallback = null;
      }
      live = "";
      pending = "";
      detach();
    };
  }, [terminalId]);

  // Resync when the window becomes visible again (hide/show, minimize):
  // refit (twice, layout settles late), re-assert pty size, repaint.
  useEffect(() => {
    const resync = (): void => {
      if (document.hidden) {
        return;
      }
      const terminal = terminalRef.current;
      const fit = fitRef.current;
      if (!terminal || !fit) {
        return;
      }
      requestAnimationFrame(() => {
        try {
          fit.fit();
        } catch {
          return;
        }
        const id = idRef.current;
        if (id) {
          void invoke("terminal.resize", {
            terminalId: id,
            cols: terminal.cols,
            rows: terminal.rows,
          }).catch(() => undefined);
        }
        // Repaint only. The viewport is left exactly where the person put it:
        // scrolling to the bottom here is what used to throw away the answer
        // someone had scrolled up to read.
        try {
          terminal.refresh(0, terminal.rows - 1);
        } catch {
          // Older xterm without refresh; nothing to repaint by hand.
        }
        setTimeout(() => {
          try {
            fit.fit();
          } catch {
            return;
          }
          const lateId = idRef.current;
          if (lateId) {
            void invoke("terminal.resize", {
              terminalId: lateId,
              cols: terminal.cols,
              rows: terminal.rows,
            }).catch(() => undefined);
          }
          try {
            terminal.refresh(0, terminal.rows - 1);
          } catch {
            // ignore
          }
        }, 300);
      });
    };
    const onVis = (): void => resync();
    const onFocus = (): void => resync();
    document.addEventListener("visibilitychange", onVis);
    window.addEventListener("focus", onFocus);
    return () => {
      document.removeEventListener("visibilitychange", onVis);
      window.removeEventListener("focus", onFocus);
    };
  }, []);

  useEffect(() => {
    if (focused) {
      terminalRef.current?.focus();
    }
  }, [focused, terminalId]);

  // A person who scrolled up to read something keeps that place while new
  // output arrives; a small way back to the newest line appears instead of
  // the view jumping under them.
  const [scrolledUp, setScrolledUp] = useState(false);
  useEffect(() => {
    const terminal = terminalRef.current;
    if (!terminal) {
      return;
    }
    const subscription = terminal.onScroll(() => {
      const { baseY, viewportY } = terminal.buffer.active;
      setScrolledUp(baseY - viewportY > 1);
    });
    return () => subscription.dispose();
  }, []);

  return (
    <div className="xterm-pane" ref={containerRef}>
      {scrolledUp ? (
        <button
          type="button"
          className="xterm-pane__latest"
          title="Jump to the newest output"
          onClick={() => {
            terminalRef.current?.scrollToBottom();
            setScrolledUp(false);
          }}
        >
          Latest output
        </button>
      ) : null}
    </div>
  );
}
