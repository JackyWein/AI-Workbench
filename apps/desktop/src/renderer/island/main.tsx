import { StrictMode, useEffect, useRef, useState, type JSX } from "react";
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

  const wheelAt = useRef(0);

  if (!state) {
    return null;
  }

  const { current, expanded } = state;
  // Whether the actions show is separate: the shape follows the service's
  // `expanded`, the buttons additionally need something to do.
  const canAct = expanded && current.action !== null;

  // Manual switching directly on the island (spec §100): click, arrows and
  // the wheel cycle, Enter follows the entry, Escape settles back.
  // Right-click steps back, standing in for the context menu's widget list
  // until the island grows its own menu.
  return (
    <div
      className="island"
      data-expanded={expanded}
      role="group"
      tabIndex={0}
      aria-label={`Status Island: ${current.title}`}
      onKeyDown={(event) => {
        if (event.key === "ArrowRight") {
          event.preventDefault();
          void window.workbenchIsland.cycle(1);
        } else if (event.key === "ArrowLeft") {
          event.preventDefault();
          void window.workbenchIsland.cycle(-1);
        } else if (event.key === "Enter") {
          // Buttons inside the actions activate natively; only the line
          // itself follows the entry on Enter.
          const target = event.target as HTMLElement | null;
          if (target?.closest(".island__actions")) {
            return;
          }
          event.preventDefault();
          if (canAct && current.action) {
            void window.workbenchIsland.open(current.action.target);
          }
        } else if (event.key === "Escape") {
          void window.workbenchIsland.dismiss();
        }
      }}
      onWheel={(event) => {
        const now = Date.now();
        if (now - wheelAt.current < 300) {
          return;
        }
        wheelAt.current = now;
        void window.workbenchIsland.cycle(event.deltaY > 0 ? 1 : -1);
      }}
      onContextMenu={(event) => {
        event.preventDefault();
        void window.workbenchIsland.cycle(-1);
      }}
    >
      <button
        type="button"
        className="island__line"
        aria-label="Next status widget"
        title="Next status widget"
        onClick={() => void window.workbenchIsland.cycle(1)}
      >
        <span className="island__dot" data-tone={toneOf(current)} aria-hidden="true" />
        <span className="island__title" title={current.title}>
          {current.title}
        </span>
      </button>

      {current.detail ? (
        <span className="island__detail" title={current.detail}>
          {current.detail}
        </span>
      ) : null}

      {/* A bar only where there are real items behind it (spec §103). */}
      {current.progress && current.progress.total > 0 ? (
        <div className="island__bar">
          <div
            className="island__bar-fill"
            style={{
              width: `${Math.min(
                100,
                Math.max(
                  0,
                  Math.round(
                    (current.progress.completed / current.progress.total) * 100,
                  ),
                ),
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
