import { type JSX, useEffect, useRef } from "react";
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
      fontSize,
      lineHeight: 1.25,
      cursorBlink: true,
      scrollback: 5000,
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
      terminal.dispose();
      terminalRef.current = null;
      fitRef.current = null;
    };
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
    const pending: string[] = [];
    let replayed = false;

    const detach = window.workbench.onTerminalEvent((event) => {
      if (event.terminalId !== terminalId) {
        return;
      }
      if (event.type === "data") {
        // Output that arrives while the scrollback is still on its way is
        // held back, so it cannot land before the history it follows.
        if (replayed) {
          terminal.write(event.chunk);
        } else {
          pending.push(event.chunk);
        }
      } else {
        terminal.write(`\r\n\x1b[2m[process exited with code ${event.exitCode}]\x1b[0m\r\n`);
      }
    });

    void invoke("terminal.reattach", { terminalId })
      .then(({ scrollback }) => {
        if (disposed) {
          return;
        }
        if (scrollback) {
          terminal.write(scrollback);
        }
        for (const chunk of pending) {
          terminal.write(chunk);
        }
        pending.length = 0;
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
      })
      .catch(() => {
        replayed = true;
      });

    return () => {
      disposed = true;
      detach();
    };
  }, [terminalId]);

  useEffect(() => {
    if (focused) {
      terminalRef.current?.focus();
    }
  }, [focused, terminalId]);

  return <div className="xterm-pane" ref={containerRef} />;
}
