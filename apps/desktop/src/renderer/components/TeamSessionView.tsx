import { useEffect, useMemo, useState, type JSX } from "react";
import type {
  AgentDefinition,
  ChatMessage,
  Session,
  TeamDefinition,
  TeamRunSnapshot,
} from "@ai-workbench/shared";
import { Composer } from "./Composer.js";
import { SessionHeader } from "./SessionHeader.js";
import { useWorkbench } from "../store/workbench.js";

/**
 * A team inside a session (spec §40–§53, §80).
 *
 * The Teams screen edits a team; this shows one working: every member as a tab,
 * that member's own conversation (what it was told, what it answered, the
 * artifacts it published) and what it is doing right now. The run snapshot is
 * the single source of truth, so this stays honest: nothing here is invented,
 * and a member that has not spoken yet says so.
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
  const progress = useWorkbench((state) => state.agentProgress);
  const refreshTeamRun = useWorkbench((state) => state.refreshTeamRun);
  const pauseTeamRun = useWorkbench((state) => state.pauseTeamRun);
  const resumeTeamRun = useWorkbench((state) => state.resumeTeamRun);
  const cancelTeamRun = useWorkbench((state) => state.cancelTeamRun);
  const startTeamRun = useWorkbench((state) => state.startTeamRun);
  const setSessionTeam = useWorkbench((state) => state.setSessionTeam);
  const clearSessionTeam = useWorkbench((state) => state.clearSessionTeam);
  const sendMessage = useWorkbench((state) => state.sendMessage);
  const cancel = useWorkbench((state) => state.cancel);
  const busy = useWorkbench((state) => state.busy[session.id] ?? false);

  const runId = (session.uiState["teamRunId"] as string | null | undefined) ?? null;
  const homePath = useWorkbench(
    (state) => state.workspaces.find((entry) => entry.id === team.workspaceId)?.path ?? "",
  );
  const [agentId, setAgentId] = useState<string>(team.agents[0]?.id ?? "");
  const [working, setWorking] = useState(false);
  const [goal, setGoal] = useState("");

  // Follow the run: it moves on its own (events refresh it), but a tick keeps
  // the view honest while a turn streams without emitting a team event.
  useEffect(() => {
    if (!runId) {
      return;
    }
    void refreshTeamRun(runId);
    const timer = setInterval(() => void refreshTeamRun(runId), 3_000);
    return () => clearInterval(timer);
  }, [refreshTeamRun, runId]);

  const run = snapshot?.run ?? null;
  const running = run?.status === "running" || run?.status === "paused";

  const tabs = useMemo(
    () => [...team.agents, ...(team.agents.length > 1 ? [ALL] : [])],
    [team.agents],
  );
  const shown = agentId === ALL ? "all" : agentId || (team.agents[0]?.id ?? "");

  const start = async (): Promise<void> => {
    const value = goal.trim();
    if (!value) {
      return;
    }
    setWorking(true);
    try {
      await startTeamRun(team.id, value);
      await setSessionTeam({ sessionId: session.id, teamId: team.id, goal: value });
      setGoal("");
    } finally {
      setWorking(false);
    }
  };

  return (
    <>
      <SessionHeader
        session={session}
        workspace={undefined}
        providers={providers}
        usage={null}
        status={run ? (running ? "working" : "idle") : undefined}
      />
      <div className="main__body">
        <div className="panel__tabs" role="tablist" aria-label="Team members">
          {tabs.map((entry) => {
            const id = entry === ALL ? ALL : (entry as AgentDefinition).id;
            const label = entry === ALL ? "All" : (entry as AgentDefinition).displayName;
            return (
              <button
                key={id}
                type="button"
                role="tab"
                className="panel__tab"
                aria-selected={shown === id}
                title={id === ALL ? "Everything the team did" : memberState(id, snapshot, progress)}
                onClick={() => setAgentId(id)}
              >
                {id !== ALL ? (
                  <span
                    className="status-dot"
                    data-state={memberDot(id, snapshot, progress)}
                    aria-hidden="true"
                  />
                ) : null}{" "}
                {label}
              </button>
            );
          })}
          <span style={{ flex: 1 }} />
          <button
            type="button"
            className="panel__tab"
            title="Leave team mode and go back to a normal session"
            onClick={() => void clearSessionTeam(session.id)}
          >
            Solo session
          </button>
        </div>

        {!run ? (
          <div className="view">
            <div className="view__inner view__inner--narrow">
              <header className="view__header">
                <div className="view__heading">
                  <h1 className="view__title">{team.name}</h1>
                  <p className="view__lede">
                    {team.agents.length} agents. Give it a goal to run.
                  </p>
                </div>
              </header>
              <div className="composer">
                <div className="composer__inner">
                  <textarea
                    className="composer__input"
                    rows={2}
                    value={goal}
                    placeholder="What should this team achieve?"
                    aria-label="Team goal"
                    onChange={(event) => setGoal(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" && !event.shiftKey) {
                        event.preventDefault();
                        void start();
                      }
                    }}
                  />
                  <div className="composer__actions">
                    <button
                      type="button"
                      className="composer__send"
                      onClick={() => void start()}
                      disabled={working || goal.trim().length === 0}
                    >
                      Start run
                    </button>
                  </div>
                </div>
              </div>
            </div>
          </div>
        ) : (
          <>
            <TeamRunHeader snapshot={snapshot} team={team} homePath={homePath} />
            <TeamMemberFeed
              snapshot={snapshot}
              team={team}
              member={shown}
              progress={progress}
            />
            <div className="scope-toggles" style={{ padding: "4px 0" }}>
              {run.status === "running" ? (
                <button
                  type="button"
                  className="quiet-button"
                  disabled={working}
                  onClick={() => {
                    setWorking(true);
                    void pauseTeamRun(run.id).finally(() => setWorking(false));
                  }}
                >
                  Pause
                </button>
              ) : run.status === "paused" ? (
                <button
                  type="button"
                  className="quiet-button"
                  disabled={working}
                  onClick={() => {
                    setWorking(true);
                    void resumeTeamRun(run.id).finally(() => setWorking(false));
                  }}
                >
                  Resume
                </button>
              ) : null}
              {running ? (
                <button
                  type="button"
                  className="quiet-button"
                  disabled={working}
                  onClick={() => {
                    setWorking(true);
                    void cancelTeamRun(run.id).finally(() => setWorking(false));
                  }}
                >
                  Stop
                </button>
              ) : null}
              <span className="row__meta">
                {run.agentCalls} calls of {run.limits.maxAgentCalls} · {run.status}
                {run.stopReason ? ` · ${run.stopReason}` : ""}
              </span>
            </div>
            <Composer
              busy={busy}
              disabled={false}
              onSend={(text) => {
                // The session still talks to its own provider; the team above
                // is what it works alongside, and says so if it is not set.
                if (session.providerId) {
                  void sendMessage(text);
                }
              }}
              onCancel={() => void cancel()}
            />
          </>
        )}
      </div>
    </>
  );
}

const ALL = "__all__";

function TeamRunHeader({
  snapshot,
  team,
  homePath,
}: {
  readonly snapshot: TeamRunSnapshot | null;
  readonly team: TeamDefinition;
  readonly homePath: string;
}): JSX.Element {
  if (!snapshot) {
    return <p className="row__meta">Loading the run…</p>;
  }
  const done = snapshot.tasks.filter((task) => task.status === "completed").length;
  return (
    <dl className="detail-list">
      <div className="detail">
        <dt className="detail__label">{team.name}</dt>
        <dd className="detail__value">
          {snapshot.run.goal}{" "}
          <span className="row__meta">
            · {done} of {snapshot.tasks.length} tasks done
          </span>
        </dd>
      </div>
      {/* Where the team writes, so "it touched my repo" is never a surprise. */}
      <div className="detail">
        <dt className="detail__label">Works in</dt>
        <dd className="detail__value detail__value--path">
          {team.settings.workingDirectory ?? homePath}
        </dd>
      </div>
    </dl>
  );
}

/**
 * One member's own story: who talked to them, what they answered, what they
 * produced, and what they are doing now. Nothing here is made up — every line
 * comes from the run the team actually persisted.
 */
function TeamMemberFeed({
  snapshot,
  team,
  member,
  progress,
}: {
  readonly snapshot: TeamRunSnapshot | null;
  readonly team: TeamDefinition;
  readonly member: string;
  readonly progress: Record<string, { agentId: string; detail: string; at: number }>;
}): JSX.Element {
  if (!snapshot) {
    return <p className="row__meta">Loading what the team did…</p>;
  }
  const agent = member === ALL ? null : team.agents.find((entry) => entry.id === member);
  const messages = snapshot.messages.filter(
    (message) =>
      member === ALL ||
      message.from === member ||
      message.to === member ||
      message.to === "*",
  );
  const tasks = snapshot.tasks.filter(
    (task) => member === ALL || task.assignedTo === member,
  );
  const artifacts = snapshot.artifacts.filter(
    (artifact) => member === ALL || artifact.createdBy === member,
  );
  const live = member === ALL ? null : progress[`${snapshot.run.id}:${member}`]?.detail;
  const feed: ChatMessage[] = [];

  for (const task of tasks) {
    feed.push(
      line(
        snapshot,
        `${task.title}`,
        task.status === "completed"
          ? `Completed${task.result ? `: ${task.result}` : ""}`
          : task.status === "failed"
            ? `Failed: ${task.error ?? "unknown"}`
            : task.status === "running"
              ? "Running"
              : task.status === "claimed"
                ? "Claimed"
                : "Waiting",
        task.assignedTo ?? "unassigned",
      ),
    );
  }
  for (const message of messages) {
    feed.push(
      line(
        snapshot,
        message.content,
        message.from === member || member === ALL ? "Said" : `To ${message.to}`,
        message.from,
      ),
    );
  }
  for (const artifact of artifacts) {
    feed.push(
      line(snapshot, `${artifact.name} (${artifact.type})`, "Published", artifact.createdBy),
    );
  }
  feed.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());

  return (
    <div className="chat" role="log" aria-live="polite" aria-label="Team activity">
      <div className="chat__inner">
        {agent ? (
          <article className="message" data-role="assistant" data-status="streaming">
            <div className="message__meta">
              {agent.displayName} <time>{memberState(agent.id, snapshot, progress)}</time>
            </div>
            <div className="message__body">
              {live ? `Working · ${live}` : memberState(agent.id, snapshot, progress)}
            </div>
          </article>
        ) : null}
        {feed.length === 0 ? (
          <p className="row__meta">
            {member === ALL
              ? "Nothing yet — the run has not produced anything."
              : "Nothing from this member yet."}
          </p>
        ) : (
          feed.map((entry) => <FeedLine key={entry.id} message={entry} />)
        )}
      </div>
    </div>
  );
}

function line(
  snapshot: TeamRunSnapshot,
  content: string,
  note: string,
  author: string,
): ChatMessage {
  return {
    id: `${snapshot.run.id}:${author}:${content.slice(0, 24)}:${note}`,
    sessionId: snapshot.run.id,
    role: "assistant",
    content,
    status: "complete",
    providerId: null,
    modelId: null,
    toolCalls: [],
    usage: null,
    error: null,
    createdAt: snapshot.run.createdAt,
    updatedAt: snapshot.run.createdAt,
  };
}

function FeedLine({ message }: { readonly message: ChatMessage }): JSX.Element {
  return (
    <article className="message" data-role="assistant" data-status={message.status}>
      <div className="message__meta">
        {message.modelId} <time>{message.content.length} chars</time>
      </div>
      <div className="message__body">{message.content}</div>
    </article>
  );
}

function memberDot(
  agentId: string,
  snapshot: TeamRunSnapshot | null,
  progress: Record<string, { agentId: string; detail: string; at: number }>,
): "running" | "waiting" | "idle" | "error" {
  if (!snapshot) {
    return "idle";
  }
  if (progress[`${snapshot.run.id}:${agentId}`]) {
    return "running";
  }
  const task = snapshot.tasks.find(
    (entry) => entry.assignedTo === agentId && entry.status === "running",
  );
  if (task) {
    return "waiting";
  }
  if (snapshot.tasks.some((entry) => entry.assignedTo === agentId && entry.status === "failed")) {
    return "error";
  }
  return "idle";
}

function memberState(
  agentId: string,
  snapshot: TeamRunSnapshot | null,
  progress: Record<string, { agentId: string; detail: string; at: number }>,
): string {
  if (!snapshot) {
    return "waiting";
  }
  const live = progress[`${snapshot.run.id}:${agentId}`]?.detail;
  if (live) {
    return `working · ${live}`;
  }
  const task = snapshot.tasks.find(
    (entry) => entry.assignedTo === agentId && entry.status === "running",
  );
  if (task) {
    return `working on ${task.title}`;
  }
  const done = snapshot.tasks.filter(
    (entry) => entry.assignedTo === agentId && entry.status === "completed",
  ).length;
  return done > 0 ? `idle · ${done} done` : "waiting";
}
