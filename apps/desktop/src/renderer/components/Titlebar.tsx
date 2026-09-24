import { type JSX, useEffect, useState } from "react";
import { Copy, Minus, Square, X } from "lucide-react";
import { invoke } from "../lib/client.js";

export function Titlebar({ label }: { readonly label: string }): JSX.Element {
  const [maximized, setMaximized] = useState(false);
  const sync = (): void => { void invoke("window.getState", undefined).then((state) => setMaximized(state.maximized || state.fullscreen)); };
  useEffect(() => {
    sync();
    window.addEventListener("resize", sync);
    window.addEventListener("focus", sync);
    return () => { window.removeEventListener("resize", sync); window.removeEventListener("focus", sync); };
  }, []);

  const toggle = (): void => {
    void invoke("window.toggleMaximize", undefined).then((state) => setMaximized(state.maximized || state.fullscreen));
  };

  return (
    <header className="titlebar" aria-label="Window controls">
      <div className="titlebar__drag" onDoubleClick={toggle}>
        <span className="titlebar__dot" aria-hidden="true" />
        <span className="titlebar__name">AI Workbench</span>
        <span className="titlebar__divider" aria-hidden="true" />
        <span className="titlebar__context">{label}</span>
      </div>
      <div className="titlebar__actions">
        <button type="button" onClick={() => void invoke("window.minimize", undefined)} aria-label="Minimize window" title="Minimize">
          <Minus size={15} strokeWidth={1.7} aria-hidden="true" />
        </button>
        <button type="button" onClick={toggle} aria-label={maximized ? "Restore window" : "Maximize window"} title={maximized ? "Restore" : "Maximize"}>
          {maximized ? <Copy size={12} strokeWidth={1.7} aria-hidden="true" /> : <Square size={12} strokeWidth={1.7} aria-hidden="true" />}
        </button>
        <button type="button" className="titlebar__close" onClick={() => void invoke("window.close", undefined)} aria-label="Close window" title="Close">
          <X size={16} strokeWidth={1.7} aria-hidden="true" />
        </button>
      </div>
    </header>
  );
}
