import { useEffect, useRef, useState, type JSX } from "react";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal, type IDisposable } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { describeError, invoke } from "../lib/client.js";

interface TerminalViewProps {
  readonly sessionId: string;
  readonly onError: (message: string) => void;
}

/**
 * Lines kept in the rendered buffer; the main process keeps the full history
 * and only a bounded tail is replayed (see XtermPane for the shared caps).
 */
const RENDER_SCROLLBACK_LINES = 2000;
/** Characters of history replayed when attaching to a running shell. */
const MAX_REATTACH_CHARS = 50_000;
/** Live output held while a frame is pending, so it cannot grow unbounded. */
const MAX_PENDING_CHARS = 200_000;

/**
 * A real shell for the session (spec §26). The process lives in the main
 * process and keeps running when this view unmounts, so switching tabs never
 * kills a running command.
 */
export function TerminalView({ sessionId, onError }: TerminalViewProps): JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const [scrolledUp, setScrolledUp] = useState(false);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) {
      return;
    }

    let disposed = false;
    let terminalId: string | null = null;
    let detach: (() => void) | null = null;
    let input: IDisposable | null = null;
    // Live output is coalesced to one write per frame so a fast command
    // cannot schedule a parse per IPC event. Fallback keeps hidden windows moving.
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

    const styles = getComputedStyle(document.documentElement);
    const token = (name: string, fallback: string): string =>
      styles.getPropertyValue(name).trim() || fallback;

    const terminal = new Terminal({
      fontFamily: token("--font-mono", "monospace"),
      fontSize: 12,
      lineHeight: 1.3,
      cursorBlink: true,
      scrollback: RENDER_SCROLLBACK_LINES,
      // The terminal uses the same surface tokens as the rest of the app.
      theme: {
        background: token("--surface-sunken", "#0a0b0d"),
        foreground: token("--text-primary", "#e8eaed"),
        cursor: token("--accent", "#6ea8fe"),
        selectionBackground: token("--surface-selected", "#2a2d33"),
      },
      allowProposedApi: true,
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(container);
    try {
      fit.fit();
    } catch {
      // Not laid out yet; the resize observer below catches up.
    }
    terminalRef.current = terminal;

    const start = async (): Promise<void> => {
      try {
        // Attaching reuses the session's shell and replays what it already
        // printed, so reopening the panel does not look like a fresh terminal.
        const { info, scrollback } = await invoke("terminal.attach", {
          sessionId,
          cols: terminal.cols,
          rows: terminal.rows,
        });

        if (disposed) {
          return;
        }
        terminalId = info.id;
        if (scrollback) {
          terminal.write(
            scrollback.length <= MAX_REATTACH_CHARS
              ? scrollback
              : scrollback.slice(scrollback.length - MAX_REATTACH_CHARS),
          );
        }

        detach = window.workbench.onTerminalEvent((event) => {
          if (event.terminalId !== terminalId) {
            return;
          }
          if (event.type === "data") {
            scheduleLive(event.chunk);
          } else {
            if (liveFrame !== null) {
              cancelAnimationFrame(liveFrame);
              flushLive();
            }
            terminal.writeln(`\r\n[process exited with code ${event.exitCode}]`);
            terminalId = null;
          }
        });

        input = terminal.onData((data) => {
          if (terminalId) {
            void invoke("terminal.write", { terminalId, data }).catch(() => undefined);
          }
        });

        // Match the pty to the rendered size once it is attached, then once
        // more after layout settles (workspace switch, panel open) so the
        // shell never keeps a mid-animation size that wraps lines wrongly.
        await invoke("terminal.resize", {
          terminalId,
          cols: terminal.cols,
          rows: terminal.rows,
        });
        const settledId = terminalId;
        setTimeout(() => {
          if (disposed || terminalId !== settledId) {
            return;
          }
          resize();
        }, 300);
      } catch (error) {
        onError(describeError(error));
      }
    };

    void start();

    const resize = (): void => {
      if (container.clientWidth === 0 || container.clientHeight === 0) {
        return;
      }
      try {
        fit.fit();
      } catch {
        return;
      }
      if (terminalId) {
        void invoke("terminal.resize", {
          terminalId,
          cols: terminal.cols,
          rows: terminal.rows,
        }).catch(() => undefined);
      }
    };

    const observer = new ResizeObserver(() => requestAnimationFrame(resize));
    observer.observe(container);

    const resync = (): void => {
      if (document.hidden) {
        return;
      }
      requestAnimationFrame(() => {
        resize();
        // Repaint only: the viewport stays where the person left it, so an
        // answer they scrolled up to read is still there.
        try {
          terminal.refresh(0, terminal.rows - 1);
        } catch {
          // ignore
        }
      });
    };
    const onVis = (): void => resync();
    const onFocus = (): void => resync();
    document.addEventListener("visibilitychange", onVis);
    window.addEventListener("focus", onFocus);

    return () => {
      disposed = true;
      observer.disconnect();
      document.removeEventListener("visibilitychange", onVis);
      window.removeEventListener("focus", onFocus);
      detach?.();
      input?.dispose();
      input = null;
      if (liveFrame !== null) {
        cancelAnimationFrame(liveFrame);
        liveFrame = null;
      }
      if (liveFallback !== null) {
        clearTimeout(liveFallback);
        liveFallback = null;
      }
      live = "";
      terminal.dispose();
      terminalRef.current = null;
      // The shell itself is deliberately left running.
    };
  }, [sessionId, onError]);

  // Scrolling up to read stays put; a quiet way back to the newest line
  // appears instead of the view jumping under the reader.
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
    <div className="terminal" ref={containerRef}>
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
