import { StrictMode, useEffect, useState, type JSX } from "react";
import { createRoot } from "react-dom/client";
import type { IslandEntry, IslandState } from "@ai-workbench/shared";
import { resolveTheme } from "@ai-workbench/ui";
import "./island.css";

/**
 * The Status Island's own renderer (spec §95–§97).
 *
 * It renders what the attention service decided and nothing more: no priority
 * logic here, and no number it was not given.
 */
function Island(): JSX.Element | null {
  const [state, setState] = useState<IslandState | null>(null);

  useEffect(() => window.workbenchIsland.onState(setState), []);

  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = (): void => {
      document.documentElement.dataset["theme"] = resolveTheme("system", media.matches);
    };
    apply();
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, []);

  if (!state) {
    return null;
  }

  const { current, expanded } = state;
  const canAct = expanded && current.action !== null;

  return (
    <div className="island" data-expanded={canAct}>
      <div className="island__line">
        <span className="island__dot" data-tone={toneOf(current)} aria-hidden="true" />
        <span className="island__title" title={current.title}>
          {current.title}
        </span>
      </div>

      {current.detail ? (
        <span className="island__detail" title={current.detail}>
          {current.detail}
        </span>
      ) : null}

      {/* A bar only where there are real items behind it (spec §103). */}
      {current.progress ? (
        <div className="island__bar">
          <div
            className="island__bar-fill"
            style={{
              width: `${Math.round(
                (current.progress.completed / current.progress.total) * 100,
              )}%`,
            }}
          />
        </div>
      ) : null}

      {canAct && current.action ? (
        <div className="island__actions">
          <button
            type="button"
            className="island__button island__button--quiet"
            onClick={() => void window.workbenchIsland.dismiss()}
          >
            Dismiss
          </button>
          <button
            type="button"
            className="island__button"
            onClick={() => void window.workbenchIsland.open(current.action!.target)}
          >
            {current.action.label}
          </button>
        </div>
      ) : null}
    </div>
  );
}

function toneOf(entry: IslandEntry): string {
  switch (entry.widget) {
    case "needsAttention":
      return "attention";
    case "errors":
    case "connectionHealth":
      return "error";
    case "completedWork":
      return "done";
    case "teamProgress":
    case "activeAgents":
      return "active";
    default:
      return "idle";
  }
}

const container = document.getElementById("island");
if (container) {
  createRoot(container).render(
    <StrictMode>
      <Island />
    </StrictMode>,
  );
}
