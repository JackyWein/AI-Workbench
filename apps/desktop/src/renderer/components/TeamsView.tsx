import { useEffect, useState, type JSX } from "react";
import { Pause, Play, Plus, Square, Trash2 } from "lucide-react";
import type {
  ProviderSummary,
  TeamDefinition,
  TeamRun,
  TeamRunSnapshot,
  TeamTask,
} from "@ai-workbench/shared";
import { useWorkbench } from "../store/workbench.js";

/**
 * The team screen (spec §70, §94).
 *
 * Quiet by default: a team is three lines until it is opened. The detail is
 * behind tabs rather than spread across a permanent dashboard, and every
 * number on it comes from the run itself.
 */
export function TeamsView(): JSX.Element {
  const teams = useWorkbench((state) => state.teams);
  const refreshTeams = useWorkbench((state) => state.refreshTeams);
  const hasWorkspace = useWorkbench((state) => state.activeWorkspaceId !== null);
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    void refreshTeams();
  }, [refreshTeams]);

  return (
    <div className="view">
      <div className="view__inner">
        <div className="view__header">
          <h1 className="view__title">Teams</h1>
          <button
            type="button"
            className="quiet-button"
            disabled={!hasWorkspace}
            onClick={() => setCreating((open) => !open)}
          >
            <Plus size={13} strokeWidth={1.75} aria-hidden="true" />
            {creating ? "Cancel" : "New team"}
          </button>
        </div>

        {!hasWorkspace ? (
          <p className="field__description">
            A team belongs to a workspace. Select one first.
          </p>
        ) : null}

        {creating ? <NewTeamForm onDone={() => setCreating(false)} /> : null}

        {teams.length === 0 && !creating ? (
          <p className="field__description">
            No teams yet. A team is a set of provider-backed agents that work on
            one goal together.
          </p>
        ) : (
          <section>
            {teams.map((team) => (
              <TeamEntry key={team.id} team={team} />
            ))}
          </section>
        )}
      </div>
    </div>
  );
}

function TeamEntry({ team }: { readonly team: TeamDefinition }): JSX.Element {
  const runs = useWorkbench((state) => state.teamRuns[team.id] ?? []);
  const openRunId = useWorkbench((state) => state.openRunId);
  const startRun = useWorkbench((state) => state.startTeamRun);
  const deleteTeam = useWorkbench((state) => state.deleteTeam);
  const setLead = useWorkbench((state) => state.setTeamLead);
  const openRun = useWorkbench((state) => state.openTeamRun);
  const [goal, setGoal] = useState("");
  const [starting, setStarting] = useState(false);

  const active = runs.filter((run) => run.status === "running").length;

  const begin = async (): Promise<void> => {
    if (goal.trim().length === 0) {
      return;
    }
    setStarting(true);
    try {
      await startRun(team.id, goal.trim());
      setGoal("");
    } finally {
      setStarting(false);
    }
  };

  return (
    <article className="provider-entry">
      <div className="provider-entry__head">
        <span className="provider-entry__name">{team.name}</span>
        {/* The compact state the specification asks for (spec §70). */}
        <span className="row__meta">
          {team.agents.length} agents · {active} active
        </span>
      </div>

      <dl className="detail-list">
        {team.agents.map((agent) => (
          <div className="detail" key={agent.id}>
            <dt className="detail__label">
              {agent.displayName}
              {agent.id === team.leadAgentId ? " · lead" : ""}
            </dt>
            <dd className="detail__value">
              {agent.providerId}
              {agent.role ? ` — ${agent.role}` : ""}
            </dd>
          </div>
        ))}
      </dl>

      <div className="provider-entry__config">
        <label className="stacked-field">
          <span className="field__description">Goal</span>
          <input
            className="text-input"
            value={goal}
            placeholder="What should this team achieve?"
            onChange={(event) => setGoal(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                void begin();
              }
            }}
          />
        </label>
        <div className="scope-toggles">
          <button
            type="button"
            className="ghost-button"
            disabled={starting || goal.trim().length === 0}
            onClick={() => void begin()}
          >
            <Play size={13} strokeWidth={1.75} aria-hidden="true" />
            {starting ? "Starting" : "Start run"}
          </button>
          {team.agents.length > 1 ? (
            <label className="scope-toggle">
              <span>Lead</span>
              <select
                className="select"
                value={team.leadAgentId ?? ""}
                onChange={(event) => void setLead(team.id, event.target.value)}
              >
                {team.agents.map((agent) => (
                  <option key={agent.id} value={agent.id}>
                    {agent.displayName}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          <button
            type="button"
            className="quiet-button"
            onClick={() => void deleteTeam(team.id)}
          >
            <Trash2 size={13} strokeWidth={1.75} aria-hidden="true" />
            Remove
          </button>
        </div>
      </div>

      {runs.length > 0 ? (
        <div className="section">
          <p className="section__label">Runs</p>
          {runs.map((run) => (
            <button
              type="button"
              key={run.id}
              className="row"
              aria-current={run.id === openRunId}
              onClick={() => void openRun(run.id === openRunId ? null : run.id)}
            >
              <span className="status-dot" data-state={dotFor(run)} aria-hidden="true" />
              <span className="row__text">{run.goal}</span>
              <span className="row__meta">{runLabel(run)}</span>
            </button>
          ))}
        </div>
      ) : null}

      {openRunId && runs.some((run) => run.id === openRunId) ? (
        <RunDetail runId={openRunId} />
      ) : null}
    </article>
  );
}

type RunTab = "tasks" | "agents" | "messages" | "artifacts" | "decisions";

function RunDetail({ runId }: { readonly runId: string }): JSX.Element {
  const snapshot = useWorkbench((state) => state.runSnapshots[runId]);
  const pauseRun = useWorkbench((state) => state.pauseTeamRun);
  const resumeRun = useWorkbench((state) => state.resumeTeamRun);
  const cancelRun = useWorkbench((state) => state.cancelTeamRun);
  const [tab, setTab] = useState<RunTab>("tasks");

  if (!snapshot) {
    return <p className="field__description">Loading the run…</p>;
  }

  const { run } = snapshot;
  const running = run.status === "running";

  return (
    <div className="run-detail">
      <div className="provider-entry__head">
        <span className="provider-entry__name">{run.goal}</span>
        <span className="row__meta">{runLabel(run)}</span>
      </div>

      {run.outcome ? <p className="notice">{run.outcome}</p> : null}
      {run.sharedState.currentPlan ? (
        <p className="field__description">{run.sharedState.currentPlan}</p>
      ) : null}

      <div className="scope-toggles">
        {running ? (
          <button
            type="button"
            className="quiet-button"
            onClick={() => void pauseRun(runId)}
          >
            <Pause size={13} strokeWidth={1.75} aria-hidden="true" />
            Pause
          </button>
        ) : run.status === "paused" ? (
          <button
            type="button"
            className="quiet-button"
            onClick={() => void resumeRun(runId)}
          >
            <Play size={13} strokeWidth={1.75} aria-hidden="true" />
            Resume
          </button>
        ) : null}
        {running || run.status === "paused" ? (
          <button
            type="button"
            className="quiet-button"
            onClick={() => void cancelRun(runId)}
          >
            <Square size={13} strokeWidth={1.75} aria-hidden="true" />
            Stop
          </button>
        ) : null}
        <span className="row__meta">
          {run.agentCalls} calls of {run.limits.maxAgentCalls}
        </span>
      </div>

      <div className="panel__tabs">
        {(["tasks", "agents", "messages", "artifacts", "decisions"] as const).map(
          (name) => (
            <button
              type="button"
              key={name}
              className="panel__tab"
              aria-current={tab === name}
              onClick={() => setTab(name)}
            >
              {name.charAt(0).toUpperCase() + name.slice(1)}
            </button>
          ),
        )}
      </div>

      {tab === "tasks" ? (
        <ul className="changes__list">
          {snapshot.tasks.length === 0 ? (
            <li className="row__meta">No tasks yet.</li>
          ) : (
            snapshot.tasks.map((task) => (
              <li className="changes__item" key={task.id}>
                <span className="changes__badge" data-state={task.status}>
                  {task.status}
                </span>
                <span className="row__text">{task.title}</span>
                <span className="row__meta">{taskDetail(task)}</span>
              </li>
            ))
          )}
        </ul>
      ) : null}

      {tab === "agents" ? <AgentActivity snapshot={snapshot} /> : null}

      {tab === "messages" ? (
        <ul className="changes__list">
          {snapshot.messages.length === 0 ? (
            <li className="row__meta">Nothing sent yet.</li>
          ) : (
            snapshot.messages.map((message) => (
              <li className="changes__item" key={message.id}>
                <span className="changes__badge">{message.type}</span>
                <span className="row__text">
                  {message.from} → {message.to}: {message.content}
                </span>
              </li>
            ))
          )}
        </ul>
      ) : null}

      {tab === "artifacts" ? (
        <ul className="changes__list">
          {snapshot.artifacts.length === 0 ? (
            <li className="row__meta">Nothing published yet.</li>
          ) : (
            snapshot.artifacts.map((artifact) => (
              <li className="changes__item" key={artifact.id}>
                <span className="changes__badge">{artifact.type}</span>
                <span className="row__text">{artifact.name}</span>
                <span className="row__meta">{artifact.createdBy}</span>
              </li>
            ))
          )}
        </ul>
      ) : null}

      {tab === "decisions" ? (
        <ul className="changes__list">
          {snapshot.decisions.length === 0 ? (
            <li className="row__meta">Nothing recorded yet.</li>
          ) : (
            snapshot.decisions.map((decision) => (
              <li className="changes__item" key={decision.id}>
                <span className="row__text">
                  {decision.title}: {decision.decision}
                </span>
                <span className="row__meta">{decision.author}</span>
              </li>
            ))
          )}
        </ul>
      ) : null}
    </div>
  );
}

/** The compact per-agent summary from spec §93. */
function AgentActivity({
  snapshot,
}: {
  readonly snapshot: TeamRunSnapshot;
}): JSX.Element {
  const teams = useWorkbench((state) => state.teams);
  const providers = useWorkbench((state) => state.providers);
  const team = teams.find((entry) => entry.id === snapshot.run.teamId);

  if (!team) {
    return <p className="row__meta">This team is no longer configured.</p>;
  }

  return (
    <dl className="detail-list">
      {team.agents.map((agent) => (
        <div className="detail" key={agent.id}>
          <dt className="detail__label">{agent.displayName}</dt>
          <dd className="detail__value">
            {agentActivity(agent.id, snapshot)}
            <span className="row__meta"> · {providerName(agent.providerId, providers)}</span>
          </dd>
        </div>
      ))}
    </dl>
  );
}

function agentActivity(agentId: string, snapshot: TeamRunSnapshot): string {
  const current = snapshot.tasks.find(
    (task) =>
      task.assignedTo === agentId &&
      (task.status === "running" || task.status === "claimed"),
  );
  if (current) {
    return `Working on ${current.title}`;
  }
  const done = snapshot.tasks.filter(
    (task) => task.assignedTo === agentId && task.status === "completed",
  ).length;
  return done > 0 ? `Idle · ${done} completed` : "Waiting";
}

function providerName(providerId: string, providers: ProviderSummary[]): string {
  return (
    providers.find((entry) => entry.metadata.id === providerId)?.metadata.displayName ??
    providerId
  );
}

function NewTeamForm({ onDone }: { readonly onDone: () => void }): JSX.Element {
  const providers = useWorkbench((state) => state.providers);
  const createTeam = useWorkbench((state) => state.createTeam);
  const [name, setName] = useState("");
  const [roster, setRoster] = useState(
    "Lead = plans and reviews\nBuilder = implements\nReviewer = checks the work",
  );
  const [providerId, setProviderId] = useState(providers[0]?.metadata.id ?? "");
  const [saving, setSaving] = useState(false);

  const submit = async (): Promise<void> => {
    const agents = roster
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map((line) => {
        const [rawName, ...rest] = line.split("=");
        return {
          displayName: (rawName ?? "").trim(),
          providerId,
          role: rest.join("=").trim(),
        };
      })
      .filter((agent) => agent.displayName.length > 0);

    if (name.trim().length === 0 || agents.length === 0) {
      return;
    }
    setSaving(true);
    try {
      await createTeam({ name: name.trim(), agents });
      onDone();
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="provider-entry">
      <div className="provider-entry__head">
        <span className="provider-entry__name">New team</span>
      </div>
      <div className="provider-entry__config">
        <label className="stacked-field">
          <span className="field__description">Name</span>
          <input
            className="text-input"
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        </label>
        <label className="stacked-field">
          <span className="field__description">Provider for every agent</span>
          <select
            className="select"
            value={providerId}
            onChange={(event) => setProviderId(event.target.value)}
          >
            {providers.map((provider) => (
              <option key={provider.metadata.id} value={provider.metadata.id}>
                {provider.metadata.displayName}
              </option>
            ))}
          </select>
        </label>
        <label className="stacked-field">
          <span className="field__description">
            Agents, one per line as <code>Name = role</code>. The first is the
            lead.
          </span>
          <textarea
            className="text-input text-input--multiline"
            rows={4}
            value={roster}
            spellCheck={false}
            onChange={(event) => setRoster(event.target.value)}
          />
        </label>
        <button
          type="button"
          className="ghost-button"
          disabled={saving || name.trim().length === 0}
          onClick={() => void submit()}
        >
          {saving ? "Creating" : "Create team"}
        </button>
      </div>
    </section>
  );
}

function runLabel(run: TeamRun): string {
  switch (run.status) {
    case "running":
      return "Running";
    case "paused":
      return "Paused";
    case "completed":
      return run.stopReason === "goalFinished" ? "Finished" : `Stopped · ${run.stopReason}`;
    case "failed":
      return "Failed";
    case "cancelled":
      return "Stopped";
    default:
      return "Not started";
  }
}

function dotFor(run: TeamRun): string {
  if (run.status === "running") {
    return "running";
  }
  return run.status === "failed" ? "error" : "idle";
}

function taskDetail(task: TeamTask): string {
  if (task.error) {
    return task.error;
  }
  if (task.result) {
    return task.result;
  }
  return task.assignedTo ?? "unassigned";
}
