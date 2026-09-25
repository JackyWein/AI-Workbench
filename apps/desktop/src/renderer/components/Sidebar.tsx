import { type JSX, useMemo, useState } from "react";
import {
  ArrowUpCircle,
  Plug,
  FolderPlus,
  Gauge,
  MessageSquarePlus,
  Settings,
  Boxes,
  BookOpen,
  Network,
  Folder,
  Trash2,
  Users,
} from "lucide-react";
import type { ChatMessage, Session, Workspace } from "@ai-workbench/shared";
import { compactNumber } from "../lib/format.js";
import {
  formatSpan,
  meterTone,
  tightestLimit,
  usageProviders,
  useNow,
} from "../lib/usage.js";
import {
  remainingShort,
  remainingStatus,
  soloSessionStats,
  teamRunStats,
} from "../lib/task-stats.js";
import { useWorkbench, type MainView } from "../store/workbench.js";
import { AppLogo } from "./AppLogo.js";
import { ModeToggle } from "./ModeToggle.js";
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
        <AppLogo className="sidebar__appmark" size={22} />
        <span className="sidebar__title">AI Workbench</span>
        {appVersion ? <span className="sidebar__version">{appVersion}</span> : null}
        <ModeToggle />
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
                      <SessionStatsLine session={session} />
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
              {update.status === "downloaded"
                ? "Restart to update"
                : update.availableVersion === update.currentVersion
                  ? `New build of ${update.availableVersion}`
                  : `Update ${update.availableVersion}`}
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
          aria-current={view === "connectors"}
          onClick={() => setView("connectors")}
        >
          <Plug size={14} strokeWidth={1.75} aria-hidden="true" />
          <span className="row__text">Connectors</span>
          {mcpServers.length > 0 ? (
            <span className="row__count">{mcpServers.length}</span>
          ) : null}
        </button>
        <button
          type="button"
          className="row"
          aria-current={view === "obsidian"}
          onClick={() => setView("obsidian")}
        >
          <Network size={14} strokeWidth={1.75} aria-hidden="true" />
          <span className="row__text">Obsidian</span>
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

/**
 * One muted stats line per session in the sidebar popover: how long it took,
 * what its turns reported, and what quota is left. Solo sessions sum their
 * messages' reported usage; team sessions read their run's tasks, turns and
 * member providers. Anything a tool did not report reads unknown/unverified —
 * never a zero or a guess — and providers are only ever told apart by their
 * own usage capability.
 */
/**
 * What a session that was never opened reads for its messages. It must be the
 * same list on every read: a store selector that hands back a new one each
 * time looks to React like a store that never settles, and it re-renders
 * until it gives up (React error 185) — hovering such a session took the
 * window down.
 */
const NO_MESSAGES: readonly ChatMessage[] = [];

function SessionStatsLine({ session }: { readonly session: Session }): JSX.Element {
  const messages = useWorkbench((state) => state.messages[session.id] ?? NO_MESSAGES);
  const runSnapshots = useWorkbench((state) => state.runSnapshots);
  const teams = useWorkbench((state) => state.teams);
  const usage = useWorkbench((state) => state.usage);
  const providers = useWorkbench((state) => state.providers);
  const now = useNow(30_000);

  const teamId =
    typeof session.uiState["teamId"] === "string" ? session.uiState["teamId"] : null;
  const teamRunId =
    typeof session.uiState["teamRunId"] === "string" ? session.uiState["teamRunId"] : null;
  const team = teamId ? teams.find((entry) => entry.id === teamId) : undefined;
  const snapshot = teamRunId ? runSnapshots[teamRunId] : undefined;

  if (team && snapshot) {
    const stats = teamRunStats(snapshot, now);
    const remaining = remainingStatus({
      usage,
      providers,
      providerIds: [...new Set(team.agents.map((agent) => agent.providerId))],
      now,
    });
    const duration =
      stats.runDurationMs !== null ? formatSpan(stats.runDurationMs) : "unknown";
    const tokens = stats.tokens !== null ? `${compactNumber(stats.tokens)} tokens` : "tokens unknown";
    const line = `${stats.tasksDone}/${stats.tasksTotal} tasks · ${duration} · ${tokens} · ${remainingShort(remaining)} remaining`;
    const detail =
      remaining.kind === "ready"
        ? remaining.detail
        : remaining.kind === "unverified"
          ? remaining.reason
          : "No member's tool reported usage yet";
    return (
      <p className="popover__detail popover__detail--stats" title={detail}>
        {line}
      </p>
    );
  }

  if (team) {
    return (
      <p className="popover__detail popover__detail--stats">Team · no run yet</p>
    );
  }

  const stats = soloSessionStats(messages);
  const remaining = remainingStatus({
    usage,
    providers,
    providerIds: session.providerId ? [session.providerId] : [],
    now,
  });
  const duration = stats.durationMs > 0 ? formatSpan(stats.durationMs) : null;
  const tokens = stats.tokens > 0 ? `${compactNumber(stats.tokens)} tokens` : null;
  const parts = [
    stats.turns === 0 ? "No turns yet" : `${stats.turns} turn${stats.turns === 1 ? "" : "s"}`,
    duration,
    tokens ?? (stats.turns === 0 ? null : "tokens unknown"),
    `${remainingShort(remaining)} remaining`,
  ].filter((part): part is string => part !== null);
  const detail =
    remaining.kind === "ready"
      ? remaining.detail
      : remaining.kind === "unverified"
        ? remaining.reason
        : "The tool has not reported usage yet";
  return (
    <p className="popover__detail popover__detail--stats" title={detail}>
      {parts.join(" · ")}
    </p>
  );
}

function dotState(status: string | undefined): string {  if (status === undefined || status === "idle") {
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
