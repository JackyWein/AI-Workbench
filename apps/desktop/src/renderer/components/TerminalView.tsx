import { useEffect, useRef, useState, type JSX } from "react";
import { FitAddon } from "@xterm/addon-fit";
import type { IDisposable, Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { describeError, invoke } from "../lib/client.js";
import { createTerminal, disposeTerminal, liveWriter, tailForReplay } from "../lib/xterm.js";

interface TerminalViewProps {
  readonly sessionId: string;
  readonly onError: (message: string) => void;
}

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
    const terminal = createTerminal({ fontSize: 12, lineHeight: 1.3 });
    const live = liveWriter(terminal);
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(container);
    try {
      fit.fit();
    } catch {
      // Not laid out yet; the resize observer below catches up.
    }
    terminalRef.current = terminal;
    setScrolledUp(false);

    // Scrolling up to read stays put; a quiet way back to the newest line
    // appears instead of the view jumping under the reader. Followed on this
    // session's terminal, so it still works after switching sessions.
    const scroll = terminal.onScroll(() => {
      const { baseY, viewportY } = terminal.buffer.active;
      setScrolledUp(baseY - viewportY > 1);
    });

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
          terminal.write(tailForReplay(scrollback));
        }

        detach = window.workbench.onTerminalEvent((event) => {
          if (event.terminalId !== terminalId) {
            return;
          }
          if (event.type === "data") {
            live.push(event.chunk);
          } else {
            live.flush();
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
      scroll.dispose();
      live.dispose();
      disposeTerminal(terminal);
      terminalRef.current = null;
      // The shell itself is deliberately left running.
    };
  }, [sessionId, onError]);

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
