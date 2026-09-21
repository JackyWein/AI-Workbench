import { type JSX } from "react";
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

  return (
    <section className="panel" aria-label="Workspace tools">
      <div className="panel__tabs" role="tablist" aria-label="Workspace tools">
        {TABS.map((entry) => (
          <button
            key={entry.id}
            type="button"
            role="tab"
            className="panel__tab"
            aria-selected={tab === entry.id}
            onClick={() => setTab(entry.id)}
          >
            {entry.label}
          </button>
        ))}
        <button
          type="button"
          className="icon-button"
          style={{ marginLeft: "auto" }}
          onClick={() => setPanelOpen(false)}
          title="Close panel"
          aria-label="Close panel"
        >
          <X size={14} strokeWidth={1.75} aria-hidden="true" />
        </button>
      </div>

      <div className="panel__body" role="tabpanel">
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
