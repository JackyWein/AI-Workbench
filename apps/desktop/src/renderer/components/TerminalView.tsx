import { useEffect, useRef, type JSX } from "react";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { describeError, invoke } from "../lib/client.js";

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

  useEffect(() => {
    const container = containerRef.current;
    if (!container) {
      return;
    }

    let disposed = false;
    let terminalId: string | null = null;
    let detach: (() => void) | null = null;

    const styles = getComputedStyle(document.documentElement);
    const token = (name: string, fallback: string): string =>
      styles.getPropertyValue(name).trim() || fallback;

    const terminal = new Terminal({
      fontFamily: token("--font-mono", "monospace"),
      fontSize: 12,
      lineHeight: 1.3,
      cursorBlink: true,
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
    fit.fit();
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
          terminal.write(scrollback);
        }

        detach = window.workbench.onTerminalEvent((event) => {
          if (event.terminalId !== terminalId) {
            return;
          }
          if (event.type === "data") {
            terminal.write(event.chunk);
          } else {
            terminal.writeln(`\r\n[process exited with code ${event.exitCode}]`);
            terminalId = null;
          }
        });

        terminal.onData((data) => {
          if (terminalId) {
            void invoke("terminal.write", { terminalId, data });
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
      fit.fit();
      if (terminalId) {
        void invoke("terminal.resize", {
          terminalId,
          cols: terminal.cols,
          rows: terminal.rows,
        });
      }
    };

    const observer = new ResizeObserver(resize);
    observer.observe(container);

    return () => {
      disposed = true;
      observer.disconnect();
      detach?.();
      terminal.dispose();
      terminalRef.current = null;
      // The shell itself is deliberately left running.
    };
  }, [sessionId, onError]);

  return <div className="terminal" ref={containerRef} />;
}
