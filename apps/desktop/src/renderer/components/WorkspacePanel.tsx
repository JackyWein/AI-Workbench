import { useRef, type JSX, type KeyboardEvent } from "react";
import { X } from "lucide-react";
import { ChangesView } from "./ChangesView.js";
import { FilesView } from "./FilesView.js";
import { TerminalView } from "./TerminalView.js";
import { useWorkbench, type WorkspaceTab } from "../store/workbench.js";

interface WorkspacePanelProps {
  readonly sessionId: string;
}

const TABS: ReadonlyArray<{ id: WorkspaceTab; label: string }> = [
  { id: "terminal", label: "Terminal" },
  { id: "files", label: "Files" },
  { id: "changes", label: "Changes" },
];

/**
 * The developer tooling that belongs to a session: a real shell, the workspace
 * files and the repository state. It is closed by default and opens on demand,
 * so the default surface stays quiet (spec §62).
 */
export function WorkspacePanel({ sessionId }: WorkspacePanelProps): JSX.Element {
  const tab = useWorkbench((state) => state.workspaceTab);
  const setTab = useWorkbench((state) => state.setWorkspaceTab);
  const setPanelOpen = useWorkbench((state) => state.setWorkspacePanelOpen);
  const setError = useWorkbench((state) => state.setError);
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);

  // Roving tabindex: only the open tab is in the tab order, arrows move
  // between tabs and select as they go.
  const onTabKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const current = TABS.findIndex((entry) => entry.id === tab);
    let next: number | null = null;
    if (event.key === "ArrowRight") {
      next = (current + 1) % TABS.length;
    } else if (event.key === "ArrowLeft") {
      next = (current - 1 + TABS.length) % TABS.length;
    } else if (event.key === "Home") {
      next = 0;
    } else if (event.key === "End") {
      next = TABS.length - 1;
    }
    const target = next === null ? undefined : TABS[next];
    if (target) {
      event.preventDefault();
      setTab(target.id);
      tabRefs.current[next ?? 0]?.focus();
    }
  };

  return (
    <section className="panel" aria-label="Workspace tools">
      <div
        className="panel__tabs"
        role="tablist"
        aria-label="Workspace tools"
        onKeyDown={onTabKeyDown}
      >
        {TABS.map((entry, index) => (
          <button
            key={entry.id}
            type="button"
            role="tab"
            id={`workspace-tab-${entry.id}`}
            aria-selected={tab === entry.id}
            aria-controls="workspace-panel"
            tabIndex={tab === entry.id ? 0 : -1}
            ref={(node) => {
              tabRefs.current[index] = node;
            }}
            className="panel__tab"
            onClick={() => setTab(entry.id)}
          >
            {entry.label}
          </button>
        ))}
        <button
          type="button"
          className="icon-button push-right"
          onClick={() => setPanelOpen(false)}
          aria-label="Close panel"
        >
          <X size={14} strokeWidth={1.75} aria-hidden="true" />
        </button>
      </div>

      <div className="panel__body" role="tabpanel" id="workspace-panel" aria-labelledby={`workspace-tab-${tab}`}>
        {/*
          Each session keeps its own views; keying on the session id makes a
          switch start clean rather than showing another session's state.
        */}
        {/*
          The terminal stays mounted and is only hidden, so its scrollback and
          scroll position survive a tab change.
        */}
        <div className="panel__pane" hidden={tab !== "terminal"}>
          <TerminalView key={sessionId} sessionId={sessionId} onError={setError} />
        </div>
        {tab === "files" ? (
          <FilesView key={sessionId} sessionId={sessionId} onError={setError} />
        ) : null}
        {tab === "changes" ? (
          <ChangesView key={sessionId} sessionId={sessionId} onError={setError} />
        ) : null}
      </div>
    </section>
  );
}
