import { type JSX, useEffect, useRef } from "react";
import { useWorkbench } from "../store/workbench.js";
import { effortLabel } from "../lib/reasoning-effort.js";

/** One confirmation for the model picker and command palette. */
export function EffortPrompt(): JSX.Element | null {
  const pending = useWorkbench((state) => state.pendingEffort);
  const cancel = useWorkbench((state) => state.cancelSessionEffort);
  const confirm = useWorkbench((state) => state.confirmSessionEffort);
  const cancelRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!pending) return;
    cancelRef.current?.focus();
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        event.preventDefault();
        cancel();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [pending, cancel]);

  if (!pending) return null;
  const level = pending.value.toLowerCase();
  const name = effortLabel(pending.value);
  return (
    <div className="effort-prompt-backdrop" onPointerDown={(event) => {
      if (event.target === event.currentTarget) cancel();
    }}>
      <div className="effort-prompt" role="dialog" aria-modal="true" aria-labelledby="effort-prompt-title" aria-describedby="effort-prompt-description" data-level={level}>
        <div className="effort-prompt__glyph" aria-hidden="true"><span /><span /><span /></div>
        <div className="effort-prompt__body">
          <h2 id="effort-prompt-title">Use {name} reasoning?</h2>
          <p id="effort-prompt-description">
            This is a high reasoning setting. Responses may take longer and use more of your provider allowance.
          </p>
          <div className="effort-prompt__actions">
            <button ref={cancelRef} type="button" className="ghost-button" onClick={cancel}>Keep current</button>
            <button type="button" className="primary-button" onClick={() => void confirm()}>Use {name}</button>
          </div>
        </div>
      </div>
    </div>
  );
}
