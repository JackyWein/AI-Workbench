import { type JSX, useMemo, useState } from "react";
import {
  ArrowUpCircle,
  FolderPlus,
  Gauge,
  MessageSquarePlus,
  Settings,
  Boxes,
  BookOpen,
  Folder,
  Puzzle,
  Server,
  Trash2,
  Users,
} from "lucide-react";
import type { Session, Workspace } from "@ai-workbench/shared";
import { meterTone, tightestLimit, usageProviders, useNow } from "../lib/usage.js";
import { useWorkbench, type MainView } from "../store/workbench.js";
import { Popover } from "./Popover.js";

interface SidebarProps {
  readonly workspaces: Workspace[];
  readonly sessions: Session[];
  readonly activeWorkspaceId: string | null;
  readonly activeSessionId: string | null;
  readonly view: MainView;
  readonly appVersion: string | null;
  readonly username: string | null;
}

export function Sidebar({
  workspaces,
  sessions,
  activeWorkspaceId,
  activeSessionId,
  view,
  appVersion,
  username,
}: SidebarProps): JSX.Element {
  const selectWorkspace = useWorkbench((state) => state.selectWorkspace);
  const selectSession = useWorkbench((state) => state.selectSession);
  const createWorkspace = useWorkbench((state) => state.createWorkspace);
  const createSession = useWorkbench((state) => state.createSession);
  const deleteWorkspace = useWorkbench((state) => state.deleteWorkspace);
  const deleteSession = useWorkbench((state) => state.deleteSession);
  const chooseDirectory = useWorkbench((state) => state.chooseDirectory);
  const setView = useWorkbench((state) => state.setView);
  const status = useWorkbench((state) => state.status);
  const messages = useWorkbench((state) => state.messages);
  const setPaletteOpen = useWorkbench((state) => state.setPaletteOpen);
  const skills = useWorkbench((state) => state.skills);
  const plugins = useWorkbench((state) => state.plugins);
  const mcpServers = useWorkbench((state) => state.mcpServers);
  const providers = useWorkbench((state) => state.providers);
  const teams = useWorkbench((state) => state.teams);
  const update = useWorkbench((state) => state.update);
  const usage = useWorkbench((state) => state.usage);
  const developerMode = useWorkbench((state) => state.settings.developerMode);
  const now = useNow(30_000);

  // Sidebar card: the OS account, the tools that are ready, and the quota
  // closest to running out across them — every value read, never written.
  const ready = useMemo(
    () => usageProviders(providers, developerMode),
    [providers, developerMode],
  );
  const tightest = tightestLimit(
    usage,
    new Set(ready.map((provider) => provider.metadata.id)),
    now,
  );
  const tightestName = tightest
    ? (providers.find((entry) => entry.metadata.id === tightest.providerId)?.metadata
        .displayName ?? tightest.providerId)
    : null;
  const displayName = username ?? "local";
  const initials = displayName
    .split(/[\s._-]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part.charAt(0).toUpperCase())
    .join("") || "?";

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
        <span className="sidebar__appmark" aria-hidden="true">
          W
        </span>
        <span className="sidebar__title">AI Workbench</span>
        {appVersion ? <span className="sidebar__version">{appVersion}</span> : null}
        <button
          type="button"
          className="icon-button"
          onClick={() => void addWorkspace()}
          aria-label="Add workspace"
        >
          <FolderPlus size={15} strokeWidth={1.75} aria-hidden="true" />
        </button>
      </div>

      <div className="sidebar__searchwrap">
        <button
          type="button"
          className="sidebar__search"
          onClick={() => setPaletteOpen(true)}
          aria-label="Search or command (Ctrl+K)"
          title="Search or command (Ctrl+K)"
        >
          <span className="sidebar__search-text">Search or command…</span>
          <kbd className="kbd">Ctrl K</kbd>
        </button>
      </div>

      <div className="sidebar__scroll">
        <div className="section">
          <p className="section__label">Workspaces</p>
          {workspaces.length === 0 ? (
            <p className="row__meta sidebar__empty">No workspaces yet</p>
          ) : (
            workspaces.map((workspace) => {
              const current = workspace.id === activeWorkspaceId;
              return (
                <div key={workspace.id} className="sidebar__row" data-current={current}>
                  <Popover
                    title="Workspace path"
                    triggerClassName="row"
                    current={current}
                    toggleOnClick={false}
                    onTriggerClick={() => void selectWorkspace(workspace.id)}
                    trigger={
                      <>
                        <Folder size={14} strokeWidth={1.75} aria-hidden="true" />
                        <span className="row__text">{workspace.name}</span>
                      </>
                    }
                  >
                    <p className="popover__detail">{workspace.path}</p>
                  </Popover>
                  <button
                    type="button"
                    className="icon-button sidebar__delete"
                    onClick={() => void deleteWorkspace(workspace.id)}
                    aria-label={`Delete workspace ${workspace.name}`}
                    title={`Delete workspace ${workspace.name}`}
                  >
                    <Trash2 size={13} strokeWidth={1.75} aria-hidden="true" />
                  </button>
                </div>
              );
            })
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
                aria-label="New session"
              >
                <MessageSquarePlus size={14} strokeWidth={1.75} aria-hidden="true" />
              </button>
            </p>
            {sessions.length === 0 ? (
              <p className="row__meta sidebar__empty">No sessions</p>
            ) : (
              sessions.map((session) => {
                const current = session.id === activeSessionId && view === "chat";
                const sessionStatus = status[session.id];
                const needsYou = sessionStatus === "waiting" || sessionStatus === "error";
                const count = messages[session.id]?.length ?? 0;
                return (
                  // The same shape as a workspace row: the thing, then the
                  // action on it, on one line.
                  <div key={session.id} className="sidebar__row" data-current={current}>
                    <Popover
                      title="Working directory"
                      triggerClassName="row"
                      current={current}
                      toggleOnClick={false}
                      onTriggerClick={() => void selectSession(session.id)}
                      trigger={
                        <>
                          <span
                            className="status-dot"
                            data-state={dotState(status[session.id])}
                            aria-hidden="true"
                          />
                          <span className="row__text">{session.name}</span>
                          {needsYou ? (
                            <span
                              className="row__count hot"
                              title={sessionStatus === "error" ? "Needs you — error" : "Needs you — waiting"}
                            >
                              !
                            </span>
                          ) : count > 0 ? (
                            <span className="row__count">{count}</span>
                          ) : null}
                        </>
                      }
                    >
                      <p className="popover__detail">{session.workingDirectory}</p>
                    </Popover>
                    <button
                      type="button"
                      className="icon-button sidebar__delete"
                      onClick={() => void deleteSession(session.id)}
                      aria-label={`Delete session ${session.name}`}
                      title={`Delete session ${session.name}`}
                    >
                      <Trash2 size={13} strokeWidth={1.75} aria-hidden="true" />
                    </button>
                  </div>
                );
              })
            )}
          </div>
        ) : null}
      </div>

      <div className="sidebar__foot">
        {update?.availableVersion &&
        (update.status === "available" || update.status === "downloaded") ? (
          <button
            type="button"
            className="row row--notice"
            onClick={() => setView("settings")}
            title="See what's new and update in Settings"
          >
            <ArrowUpCircle size={14} strokeWidth={1.75} aria-hidden="true" />
            <span className="row__text">
              {update.status === "downloaded" ? "Restart to update" : `Update ${update.availableVersion}`}
            </span>
          </button>
        ) : null}
        <button
          type="button"
          className="row"
          aria-current={view === "providers"}
          onClick={() => setView("providers")}
        >
          <Boxes size={14} strokeWidth={1.75} aria-hidden="true" />
          <span className="row__text">Providers</span>
          {providers.length > 0 ? (
            <span className="row__count">{providers.length}</span>
          ) : null}
        </button>
        <button
          type="button"
          className="row"
          aria-current={view === "usage"}
          onClick={() => setView("usage")}
        >
          <Gauge size={14} strokeWidth={1.75} aria-hidden="true" />
          <span className="row__text">Usage</span>
        </button>
        <button
          type="button"
          className="row"
          aria-current={view === "skills"}
          onClick={() => setView("skills")}
        >
          <BookOpen size={14} strokeWidth={1.75} aria-hidden="true" />
          <span className="row__text">Skills</span>
          {skills.length > 0 ? <span className="row__count">{skills.length}</span> : null}
        </button>
        <button
          type="button"
          className="row"
          aria-current={view === "plugins"}
          onClick={() => setView("plugins")}
        >
          <Puzzle size={14} strokeWidth={1.75} aria-hidden="true" />
          <span className="row__text">Plugins</span>
          {plugins.length > 0 ? (
            <span className="row__count">{plugins.length}</span>
          ) : null}
        </button>
        <button
          type="button"
          className="row"
          aria-current={view === "teams"}
          onClick={() => setView("teams")}
        >
          <Users size={14} strokeWidth={1.75} aria-hidden="true" />
          <span className="row__text">Teams</span>
          {teams.length > 0 ? <span className="row__count">{teams.length}</span> : null}
        </button>
        <button
          type="button"
          className="row"
          aria-current={view === "mcp"}
          onClick={() => setView("mcp")}
        >
          <Server size={14} strokeWidth={1.75} aria-hidden="true" />
          <span className="row__text">MCP servers</span>
          {mcpServers.length > 0 ? (
            <span className="row__count">{mcpServers.length}</span>
          ) : null}
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
        <button
          type="button"
          className="sidebar__user"
          aria-current={view === "usage"}
          onClick={() => setView("usage")}
          title={
            tightest
              ? `${tightestName} · ${tightest.limit.label}: ${tightest.percentUsed}% used`
              : "Usage"
          }
        >
          <span className="sidebar__avatar" aria-hidden="true">
            {initials}
          </span>
          <span className="sidebar__who">
            <span className="sidebar__who-name">{displayName}</span>
            <span className="sidebar__who-plan">
              {tightest
                ? `${tightestName} · ${tightest.limit.label.toLowerCase()}`
                : ready.length === 1
                  ? "1 tool ready"
                  : `${ready.length} tools ready`}
            </span>
          </span>
          {tightest ? (
            <span className="sidebar__usage" data-tone={meterTone(tightest.percentUsed)}>
              <span
                className="ring"
                style={{
                  background: `conic-gradient(currentColor ${tightest.percentUsed * 3.6}deg, var(--surface-active) 0)`,
                }}
                aria-hidden="true"
              />
              {tightest.percentUsed}%
            </span>
          ) : (
            <Gauge size={14} strokeWidth={1.75} aria-hidden="true" className="sidebar__usage-icon" />
          )}
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
  if (status === "waiting") {
    return "waiting";
  }
  return "running";
}
