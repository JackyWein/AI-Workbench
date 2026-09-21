import { useEffect, useRef, type JSX } from "react";
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
    // cannot schedule a parse per IPC event.
    let live = "";
    let liveFrame: number | null = null;
    const flushLive = (): void => {
      liveFrame = null;
      if (live.length === 0 || disposed) {
        live = "";
        return;
      }
      const chunk = live;
      live = "";
      terminal.write(chunk);
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
            live += event.chunk;
            if (live.length > MAX_PENDING_CHARS) {
              live = live.slice(live.length - MAX_PENDING_CHARS);
            }
            liveFrame ??= requestAnimationFrame(flushLive);
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

        // Match the pty to the rendered size once it is attached.
        await invoke("terminal.resize", {
          terminalId,
          cols: terminal.cols,
          rows: terminal.rows,
        });
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

    return () => {
      disposed = true;
      observer.disconnect();
      detach?.();
      input?.dispose();
      input = null;
      if (liveFrame !== null) {
        cancelAnimationFrame(liveFrame);
        liveFrame = null;
      }
      live = "";
      terminal.dispose();
      terminalRef.current = null;
      // The shell itself is deliberately left running.
    };
  }, [sessionId, onError]);

  return <div className="terminal" ref={containerRef} />;
}
