import { type JSX, useState } from "react";
import {
  FolderPlus,
  MessageSquarePlus,
  Settings,
  Boxes,
  Folder,
} from "lucide-react";
import type { Session, Workspace } from "@ai-workbench/shared";
import { formatPath } from "../lib/format.js";
import { useWorkbench, type MainView } from "../store/workbench.js";

interface SidebarProps {
  readonly workspaces: Workspace[];
  readonly sessions: Session[];
  readonly activeWorkspaceId: string | null;
  readonly activeSessionId: string | null;
  readonly view: MainView;
}

export function Sidebar({
  workspaces,
  sessions,
  activeWorkspaceId,
  activeSessionId,
  view,
}: SidebarProps): JSX.Element {
  const selectWorkspace = useWorkbench((state) => state.selectWorkspace);
  const selectSession = useWorkbench((state) => state.selectSession);
  const createWorkspace = useWorkbench((state) => state.createWorkspace);
  const createSession = useWorkbench((state) => state.createSession);
  const chooseDirectory = useWorkbench((state) => state.chooseDirectory);
  const setView = useWorkbench((state) => state.setView);
  const status = useWorkbench((state) => state.status);

  const [creating, setCreating] = useState(false);

  const addWorkspace = async (): Promise<void> => {
    if (creating) {
      return;
    }
    setCreating(true);
    try {
      const path = await chooseDirectory();
      if (path) {
        const name = path.split(/[\\/]/).filter(Boolean).pop() ?? "Workspace";
        await createWorkspace(name, path);
      }
    } finally {
      setCreating(false);
    }
  };

  const addSession = async (): Promise<void> => {
    const count = sessions.length + 1;
    await createSession({ name: `Session ${count}` });
  };

  return (
    <nav className="sidebar" aria-label="Workspaces and sessions">
      <div className="sidebar__head">
        <span className="sidebar__title">AI Workbench</span>
        <button
          type="button"
          className="icon-button"
          onClick={() => void addWorkspace()}
          title="Add workspace"
          aria-label="Add workspace"
        >
          <FolderPlus size={15} strokeWidth={1.75} aria-hidden="true" />
        </button>
      </div>

      <div className="sidebar__scroll">
        <div className="section">
          <p className="section__label">Workspaces</p>
          {workspaces.length === 0 ? (
            <p className="row__meta" style={{ padding: "0 8px" }}>
              No workspaces yet
            </p>
          ) : (
            workspaces.map((workspace) => (
              <button
                type="button"
                key={workspace.id}
                className="row"
                aria-current={workspace.id === activeWorkspaceId}
                onClick={() => void selectWorkspace(workspace.id)}
                title={workspace.path}
              >
                <Folder size={14} strokeWidth={1.75} aria-hidden="true" />
                <span className="row__text">{workspace.name}</span>
              </button>
            ))
          )}
        </div>

        {activeWorkspaceId ? (
          <div className="section">
            <p className="section__label">
              Sessions
              <button
                type="button"
                className="icon-button"
                onClick={() => void addSession()}
                title="New session"
                aria-label="New session"
              >
                <MessageSquarePlus size={14} strokeWidth={1.75} aria-hidden="true" />
              </button>
            </p>
            {sessions.length === 0 ? (
              <p className="row__meta" style={{ padding: "0 8px" }}>
                No sessions
              </p>
            ) : (
              sessions.map((session) => (
                <button
                  type="button"
                  key={session.id}
                  className="row"
                  aria-current={session.id === activeSessionId && view === "chat"}
                  onClick={() => void selectSession(session.id)}
                  title={formatPath(session.workingDirectory)}
                >
                  <span
                    className="status-dot"
                    data-state={dotState(status[session.id])}
                    aria-hidden="true"
                  />
                  <span className="row__text">{session.name}</span>
                </button>
              ))
            )}
          </div>
        ) : null}
      </div>

      <div className="sidebar__foot">
        <button
          type="button"
          className="row"
          aria-current={view === "providers"}
          onClick={() => setView("providers")}
        >
          <Boxes size={14} strokeWidth={1.75} aria-hidden="true" />
          <span className="row__text">Providers</span>
        </button>
        <button
          type="button"
          className="row"
          aria-current={view === "settings"}
          onClick={() => setView("settings")}
        >
          <Settings size={14} strokeWidth={1.75} aria-hidden="true" />
          <span className="row__text">Settings</span>
        </button>
      </div>
    </nav>
  );
}

function dotState(status: string | undefined): string {
  if (status === undefined || status === "idle") {
    return "idle";
  }
  if (status === "error") {
    return "error";
  }
  return "running";
}
