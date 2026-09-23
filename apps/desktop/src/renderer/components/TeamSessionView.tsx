import { useEffect, useMemo, useRef, useState, type JSX } from "react";
import { Pause, Play, Square } from "lucide-react";
import type {
  AgentDefinition,
  Session,
  TeamArtifact,
  TeamDecision,
  TeamDefinition,
  TeamMessage,
  TeamRun,
  TeamRunSnapshot,
  TeamTask,
} from "@ai-workbench/shared";
import { Composer } from "./Composer.js";
import { MessageBody } from "./MessageItem.js";
import { SessionHeader } from "./SessionHeader.js";
import { useWorkbench } from "../store/workbench.js";
import { useNow } from "../lib/usage.js";

/**
 * A team working inside a session (spec §40–§53, §80).
 *
 * The session's own conversation makes way for the team's: every member is a
 * tab with its own story — what it was asked, what it answered, the tasks it
 * worked on and what it published — in the order it happened, and a line on
 * what it is doing right now. The run is the only source; nothing here is
 * made up, and a member that has not spoken yet says so.
 *
 * The box at the bottom gives the team a goal, which starts a run in this
 * session's workspace, or, while a run is going, a note to its lead that the
 * lead reads on its next turn.
 */
export function TeamSessionView({
  session,
  team,
  snapshot,
}: {
  readonly session: Session;
  readonly team: TeamDefinition;
  readonly snapshot: TeamRunSnapshot | null;
}): JSX.Element {
  const providers = useWorkbench((state) => state.providers);
  const workspaces = useWorkbench((state) => state.workspaces);
  const progress = useWorkbench((state) => state.agentProgress);
  const refreshTeamRun = useWorkbench((state) => state.refreshTeamRun);
  const pauseTeamRun = useWorkbench((state) => state.pauseTeamRun);
  const resumeTeamRun = useWorkbench((state) => state.resumeTeamRun);
  const cancelTeamRun = useWorkbench((state) => state.cancelTeamRun);
  const setSessionTeam = useWorkbench((state) => state.setSessionTeam);
  const clearSessionTeam = useWorkbench((state) => state.clearSessionTeam);
  const sendTeamNote = useWorkbench((state) => state.sendTeamNote);
  const now = useNow(5_000);

  const runId = (session.uiState["teamRunId"] as string | null | undefined) ?? null;
  const workspace = workspaces.find((entry) => entry.id === session.workspaceId);
  const [member, setMember] = useState<string>(TEAM);
  const [working, setWorking] = useState(false);

  // Follow the run: team events refresh it, and a slow tick keeps it honest
  // while a turn streams without producing a team event.
  useEffect(() => {
    if (!runId) {
      return;
    }
    void refreshTeamRun(runId);
    const timer = setInterval(() => void refreshTeamRun(runId), 3_000);
    return () => clearInterval(timer);
  }, [refreshTeamRun, runId]);

  const run = snapshot && snapshot.run.id === runId ? snapshot.run : null;
  const going = run?.status === "running" || run?.status === "pending";
  const lead = team.agents.find((agent) => agent.id === team.leadAgentId) ?? team.agents[0];
  // Where this run writes: the team's own folder, or this session's workspace.
  const folder =
    team.settings.workingDirectory ??
    workspaces.find((entry) => entry.id === (run?.workspaceId ?? session.workspaceId))?.path ??
    workspace?.path ??
    null;

  const live = (agentId: string): string | null => {
    if (!run) {
      return null;
    }
    const entry = progress[`${run.id}:${agentId}`];
    return entry && going && now - entry.at < LIVE_MS ? entry.detail : null;
  };

  const act = (action: () => Promise<unknown>): void => {
    setWorking(true);
    void action().finally(() => setWorking(false));
  };

  return (
    <>
      <SessionHeader
        session={session}
        workspace={workspace}
        providers={providers}
        usage={null}
        status={going ? "working" : run ? "idle" : undefined}
      />
      <div className="main__body team-session">
        <header className="team-run">
          <div className="team-run__title">
            <span className="team-run__team">{team.name}</span>
            {run ? (
              <span className="pill" data-tone={statusTone(run)}>
                {statusLabel(run)}
              </span>
            ) : null}
            <span className="team-run__spacer" />
            {run?.status === "running" ? (
              <button
                type="button"
                className="quiet-button"
                disabled={working}
                onClick={() => act(() => pauseTeamRun(run.id))}
              >
                <Pause size={13} strokeWidth={1.75} aria-hidden="true" />
                Pause
              </button>
            ) : null}
            {run?.status === "paused" ? (
              <button
                type="button"
                className="quiet-button"
                disabled={working}
                onClick={() => act(() => resumeTeamRun(run.id))}
              >
                <Play size={13} strokeWidth={1.75} aria-hidden="true" />
                Resume
              </button>
            ) : null}
            {run && (going || run.status === "paused") ? (
              <button
                type="button"
                className="quiet-button"
                disabled={working}
                onClick={() => act(() => cancelTeamRun(run.id))}
              >
                <Square size={12} strokeWidth={1.75} aria-hidden="true" />
                Stop
              </button>
            ) : null}
            <button
              type="button"
              className="quiet-button"
              title="Leave team mode; the session talks to its own model again"
              onClick={() => void clearSessionTeam(session.id)}
            >
              Solo session
            </button>
          </div>
          {run ? <p className="team-run__goal">{run.goal}</p> : null}
          <p className="team-run__meta">
            {folder ? (
              <>
                Works in <span className="team-run__path">{folder}</span>
              </>
            ) : (
              "No folder: open a local workspace"
            )}
            {run && snapshot ? (
              <>
                {" · "}
                {snapshot.tasks.filter((task) => task.status === "completed").length} of{" "}
                {snapshot.tasks.length} tasks done · {run.agentCalls} of {run.limits.maxAgentCalls}{" "}
                calls
              </>
            ) : null}
          </p>
        </header>

        <div className="panel__tabs team-tabs" role="tablist" aria-label="Team members">
          <button
            type="button"
            role="tab"
            className="panel__tab"
            aria-selected={member === TEAM}
            onClick={() => setMember(TEAM)}
          >
            Team
          </button>
          {team.agents.map((agent) => (
            <button
              key={agent.id}
              type="button"
              role="tab"
              className="panel__tab"
              aria-selected={member === agent.id}
              title={memberState(agent.id, snapshot, live(agent.id))}
              onClick={() => setMember(agent.id)}
            >
              <span
                className="status-dot"
                data-state={memberDot(agent.id, snapshot, live(agent.id))}
                aria-hidden="true"
              />
              {agent.displayName}
            </button>
          ))}
        </div>

        <TeamFeed
          team={team}
          snapshot={run ? snapshot : null}
          member={member}
          live={live}
          folder={folder}
        />

        <Composer
          busy={false}
          disabled={false}
          placeholder={
            going
              ? `Note to ${lead?.displayName ?? "the team"} — read on its next turn`
              : "Give the team a goal…"
          }
          onSend={(text) => {
            if (going && run) {
              void sendTeamNote(run.id, text);
            } else {
              // One new run, in this session's workspace.
              void setSessionTeam({ sessionId: session.id, teamId: team.id, goal: text });
            }
          }}
          onCancel={() => undefined}
        />
      </div>
    </>
  );
}

/** How long a progress report counts as "doing this now". */
const LIVE_MS = 20_000;
const TEAM = "__team__";

type FeedEntry =
  | { readonly kind: "message"; readonly id: string; readonly at: Date; readonly message: TeamMessage }
  | { readonly kind: "task"; readonly id: string; readonly at: Date; readonly task: TeamTask }
  | { readonly kind: "artifact"; readonly id: string; readonly at: Date; readonly artifact: TeamArtifact }
  | { readonly kind: "decision"; readonly id: string; readonly at: Date; readonly decision: TeamDecision };

function TeamFeed({
  team,
  snapshot,
  member,
  live,
  folder,
}: {
  readonly team: TeamDefinition;
  readonly snapshot: TeamRunSnapshot | null;
  readonly member: string;
  readonly live: (agentId: string) => string | null;
  readonly folder: string | null;
}): JSX.Element {
  const scroller = useRef<HTMLDivElement>(null);
  const names = useMemo(() => new Map(team.agents.map((agent) => [agent.id, agent.displayName])), [team.agents]);
  const nameOf = (id: string): string =>
    id === "user" ? "You" : id === "*" ? "everyone" : (names.get(id) ?? id);

  const entries = useMemo(() => (snapshot ? feedFor(snapshot, member) : []), [snapshot, member]);

  // Stays at the newest entry while someone reads there; scrolled up, it
  // leaves them where they are.
  useEffect(() => {
    const element = scroller.current;
    if (!element) {
      return;
    }
    const nearBottom = element.scrollHeight - element.scrollTop - element.clientHeight < 160;
    if (nearBottom) {
      element.scrollTop = element.scrollHeight;
    }
  }, [entries.length]);

  const agent = member === TEAM ? null : team.agents.find((entry) => entry.id === member);

  return (
    <div className="chat team-feed" ref={scroller} role="log" aria-live="polite" aria-label="Team activity">
      <div className="chat__inner">
        {!snapshot ? (
          <TeamIntro team={team} folder={folder} />
        ) : (
          <>
            {agent ? <NowLine agent={agent} snapshot={snapshot} live={live(agent.id)} /> : null}
            {entries.length === 0 ? (
              <p className="team-feed__empty">
                {agent ? `Nothing from ${agent.displayName} yet.` : "Nothing yet — the run has just begun."}
              </p>
            ) : (
              entries.map((entry) => <FeedItem key={entry.id} entry={entry} nameOf={nameOf} />)
            )}
            {!agent
              ? team.agents
                  .map((member) => ({ member, detail: live(member.id) }))
                  .filter((entry) => entry.detail !== null)
                  .map(({ member, detail }) => (
                    <p className="team-feed__live" key={member.id}>
                      <span className="status-dot" data-state="running" aria-hidden="true" />
                      {member.displayName} · {detail}
                    </p>
                  ))
              : null}
          </>
        )}
      </div>
    </div>
  );
}

/** Before the first run: who is on the team and where it will work. */
function TeamIntro({
  team,
  folder,
}: {
  readonly team: TeamDefinition;
  readonly folder: string | null;
}): JSX.Element {
  return (
    <div className="team-intro">
      <p className="team-intro__title">{team.name} is ready</p>
      <ul className="team-intro__members">
        {team.agents.map((agent) => (
          <li key={agent.id}>
            <span className="team-intro__name">
              {agent.displayName}
              {agent.id === team.leadAgentId ? " · lead" : ""}
            </span>
            {agent.role ? <span className="team-intro__role">{agent.role}</span> : null}
          </li>
        ))}
      </ul>
      <p className="team-intro__hint">
        Write a goal below. The team works in {folder ?? "this session's workspace"}.
      </p>
    </div>
  );
}

/** What one member is doing now, in its own words when it reported any. */
function NowLine({
  agent,
  snapshot,
  live,
}: {
  readonly agent: AgentDefinition;
  readonly snapshot: TeamRunSnapshot;
  readonly live: string | null;
}): JSX.Element {
  return (
    <p className="team-now" data-state={memberDot(agent.id, snapshot, live)}>
      <span className="status-dot" data-state={memberDot(agent.id, snapshot, live)} aria-hidden="true" />
      {memberState(agent.id, snapshot, live)}
    </p>
  );
}

function FeedItem({
  entry,
  nameOf,
}: {
  readonly entry: FeedEntry;
  readonly nameOf: (id: string) => string;
}): JSX.Element {
  const time = entry.at.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  switch (entry.kind) {
    case "message": {
      const { message } = entry;
      return (
        <article className="team-entry" data-kind="message" data-type={message.type}>
          <div className="team-entry__meta">
            <span className="team-entry__who">{nameOf(message.from)}</span>
            <span className="team-entry__to">to {nameOf(message.to)}</span>
            {message.type !== "info" ? <span className="team-entry__tag">{message.type}</span> : null}
            <time>{time}</time>
          </div>
          <Collapsible text={message.content} />
        </article>
      );
    }
    case "task": {
      const { task } = entry;
      return (
        <article className="team-entry" data-kind="task" data-status={task.status}>
          <div className="team-entry__meta">
            <span className="team-entry__who">Task</span>
            <span className="team-entry__to">
              {task.assignedTo ? `for ${nameOf(task.assignedTo)}` : `by ${nameOf(task.createdBy)}`}
            </span>
            <span className="team-entry__tag" data-status={task.status}>
              {taskLabel(task)}
            </span>
            <time>{time}</time>
          </div>
          <p className="team-entry__title">{task.title}</p>
          {task.status === "failed" && task.error ? (
            <p className="team-entry__error">{task.error}</p>
          ) : null}
          {task.status === "completed" && task.result ? <Collapsible text={task.result} /> : null}
        </article>
      );
    }
    case "artifact": {
      const { artifact } = entry;
      return (
        <article className="team-entry" data-kind="artifact">
          <div className="team-entry__meta">
            <span className="team-entry__who">{nameOf(artifact.createdBy)}</span>
            <span className="team-entry__to">published</span>
            <span className="team-entry__tag">{artifact.type}</span>
            <time>{time}</time>
          </div>
          <p className="team-entry__title">{artifact.path ?? artifact.name}</p>
          {artifact.content ? (
            <details className="team-entry__details">
              <summary>Show content</summary>
              <MessageBody content={artifact.content} role="assistant" />
            </details>
          ) : null}
        </article>
      );
    }
    case "decision": {
      const { decision } = entry;
      return (
        <article className="team-entry" data-kind="decision">
          <div className="team-entry__meta">
            <span className="team-entry__who">{nameOf(decision.author)}</span>
            <span className="team-entry__to">decided</span>
            <time>{time}</time>
          </div>
          <p className="team-entry__title">{decision.title}</p>
          <Collapsible text={decision.decision} />
        </article>
      );
    }
  }
}

/** Long text folds after a few lines, so one answer does not bury the rest. */
function Collapsible({ text }: { readonly text: string }): JSX.Element {
  const [open, setOpen] = useState(false);
  const long = text.length > 900;
  return (
    <div className="team-entry__body" data-folded={long && !open}>
      <MessageBody content={long && !open ? `${text.slice(0, 900)}…` : text} role="assistant" />
      {long ? (
        <button type="button" className="link-button" onClick={() => setOpen((value) => !value)}>
          {open ? "Show less" : "Show all"}
        </button>
      ) : null}
    </div>
  );
}

/**
 * One member's story, or the whole team's: messages it sent or received,
 * tasks it worked on or handed out, what it published and decided — each at
 * the moment it happened.
 */
function feedFor(snapshot: TeamRunSnapshot, member: string): FeedEntry[] {
  const mine = (id: string | null): boolean => member === TEAM || id === member;
  const entries: FeedEntry[] = [];
  for (const message of snapshot.messages) {
    if (member === TEAM || message.from === member || message.to === member) {
      entries.push({ kind: "message", id: `m:${message.id}`, at: message.timestamp, message });
    }
  }
  for (const task of snapshot.tasks) {
    if (mine(task.assignedTo) || (member !== TEAM && task.createdBy === member && !task.assignedTo)) {
      // A task shows where it stands, at the moment it last moved.
      entries.push({
        kind: "task",
        id: `t:${task.id}`,
        at: task.completedAt ?? task.startedAt ?? task.createdAt,
        task,
      });
    }
  }
  for (const artifact of snapshot.artifacts) {
    if (mine(artifact.createdBy)) {
      entries.push({ kind: "artifact", id: `a:${artifact.id}`, at: artifact.timestamp, artifact });
    }
  }
  for (const decision of snapshot.decisions) {
    if (mine(decision.author)) {
      entries.push({ kind: "decision", id: `d:${decision.id}`, at: decision.timestamp, decision });
    }
  }
  return entries.sort((a, b) => a.at.getTime() - b.at.getTime());
}

function taskLabel(task: TeamTask): string {
  switch (task.status) {
    case "completed":
      return "done";
    case "failed":
      return "failed";
    case "running":
    case "claimed":
      return "working";
    case "blocked":
      return "blocked";
    case "cancelled":
      return "cancelled";
    default:
      return "waiting";
  }
}

function statusLabel(run: TeamRun): string {
  switch (run.status) {
    case "pending":
    case "running":
      return "Working";
    case "paused":
      return "Paused";
    case "completed":
      return "Done";
    case "cancelled":
      return "Stopped";
    case "failed":
      return "Failed";
    default:
      return run.status;
  }
}

function statusTone(run: TeamRun): string {
  switch (run.status) {
    case "pending":
    case "running":
      return "live";
    case "completed":
      return "done";
    case "failed":
      return "error";
    default:
      return "dim";
  }
}

function memberDot(
  agentId: string,
  snapshot: TeamRunSnapshot | null,
  live: string | null,
): "running" | "waiting" | "idle" | "error" {
  if (!snapshot) {
    return "idle";
  }
  if (live) {
    return "running";
  }
  const tasks = snapshot.tasks.filter((entry) => entry.assignedTo === agentId);
  if (tasks.some((entry) => entry.status === "running" || entry.status === "claimed")) {
    return "waiting";
  }
  const last = tasks
    .filter((entry) => entry.completedAt)
    .sort((a, b) => (b.completedAt?.getTime() ?? 0) - (a.completedAt?.getTime() ?? 0))[0];
  return last?.status === "failed" ? "error" : "idle";
}

function memberState(agentId: string, snapshot: TeamRunSnapshot | null, live: string | null): string {
  if (!snapshot) {
    return "Not started";
  }
  if (live) {
    return `Working · ${live}`;
  }
  const tasks = snapshot.tasks.filter((entry) => entry.assignedTo === agentId);
  const current = tasks.find((entry) => entry.status === "running" || entry.status === "claimed");
  if (current) {
    return `Working on ${current.title}`;
  }
  const done = tasks.filter((entry) => entry.status === "completed").length;
  const failed = tasks.filter((entry) => entry.status === "failed").length;
  if (done === 0 && failed === 0) {
    return "Waiting for work";
  }
  return [done > 0 ? `${done} done` : "", failed > 0 ? `${failed} failed` : ""]
    .filter(Boolean)
    .join(" · ");
}
