import { useEffect, useRef, useState, type JSX, type KeyboardEvent } from "react";
import { Pause, Play, Plus, Square, Trash2 } from "lucide-react";
import type {
  ProviderSummary,
  TeamDefinition,
  TeamRun,
  TeamRunSnapshot,
  TeamTask,
} from "@ai-workbench/shared";
import { useWorkbench } from "../store/workbench.js";
import { Logo } from "./Logo.js";
import { providerLabel } from "../lib/provider-label.js";

/**
 * The team screen (spec §70, §94).
 *
 * Quiet by default: a team is three lines until it is opened. The detail is
 * behind tabs rather than spread across a permanent dashboard, and every
 * number on it comes from the run itself.
 */
export function TeamsView(): JSX.Element {
  const teams = useWorkbench((state) => state.teams);
  const providers = useWorkbench((state) => state.providers);
  const workspaces = useWorkbench((state) => state.workspaces);
  const refreshTeams = useWorkbench((state) => state.refreshTeams);
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    void refreshTeams();
  }, [refreshTeams]);

  const homeName = (workspaceId: string): string =>
    workspaces.find((entry) => entry.id === workspaceId)?.name ?? "Unknown workspace";

  return (
    <div className="view">
      <div className="view__inner">
        <div className="view__header">
          <h1 className="view__title">Teams</h1>
          <button
            type="button"
            className="quiet-button"
            onClick={() => setCreating((open) => !open)}
          >
            <Plus size={13} strokeWidth={1.75} aria-hidden="true" />
            {creating ? "Cancel" : "New team"}
          </button>
        </div>

        <p className="field__description">
          Teams live globally: create one from any workspace and start new runs
          on it from here at any time.
        </p>

        {creating ? <NewTeamForm onDone={() => setCreating(false)} /> : null}

        {teams.length === 0 && !creating ? (
          <p className="field__description">
            No teams yet. A team is a set of provider-backed agents that work on
            one goal together.
          </p>
        ) : (
          <section>
            {teams.map((team) => (
              <TeamEntry
                key={team.id}
                team={team}
                providers={providers}
                homeName={homeName(team.workspaceId)}
              />
            ))}
          </section>
        )}
      </div>
    </div>
  );
}

/**
 * Stable empty list: `?? []` would hand zustand a new array identity on every
 * call and re-render the entry in a loop.
 */
const EMPTY_RUNS: TeamRun[] = [];

function TeamEntry({
  team,
  providers,
  homeName,
}: {
  readonly team: TeamDefinition;
  readonly providers: readonly ProviderSummary[];
  readonly homeName: string;
}): JSX.Element {
  const runs = useWorkbench((state) => state.teamRuns[team.id] ?? EMPTY_RUNS);
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
          {team.agents.length} agents · {active} active · {homeName}
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
              <AgentProvider providerId={agent.providerId} providers={providers} />
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
        <RunDetail runId={openRunId} providers={providers} />
      ) : null}
    </article>
  );
}

type RunTab = "tasks" | "agents" | "messages" | "artifacts" | "decisions";

const RUN_TABS: readonly RunTab[] = ["tasks", "agents", "messages", "artifacts", "decisions"];

/**
 * How many run-log rows stay mounted per tab. A long run would otherwise keep
 * every row alive inside a max-height list; older rows page back in on
 * demand, anchored at the newest entries.
 */
const RUN_LIST_PAGE = 50;

const EMPTY_LIST: readonly never[] = [];

function usePagedList<T>(
  items: readonly T[],
  resetKey: string,
): { readonly visible: readonly T[]; readonly hidden: number; readonly showMore: () => void } {
  const [count, setCount] = useState(RUN_LIST_PAGE);
  useEffect(() => {
    setCount(RUN_LIST_PAGE);
  }, [resetKey]);
  const hidden = Math.max(0, items.length - count);
  const visible = hidden === 0 ? items : items.slice(hidden);
  return {
    visible,
    hidden,
    showMore: () => setCount((current) => current + RUN_LIST_PAGE),
  };
}

function ListPager({
  hidden,
  onShowMore,
}: {
  readonly hidden: number;
  readonly onShowMore: () => void;
}): JSX.Element | null {
  if (hidden === 0) {
    return null;
  }
  return (
    <button type="button" className="quiet-button" onClick={onShowMore}>
      <span className="row__meta">Show earlier ({hidden} hidden)</span>
    </button>
  );
}

function RunDetail({
  runId,
  providers,
}: {
  readonly runId: string;
  readonly providers: readonly ProviderSummary[];
}): JSX.Element {
  const snapshot = useWorkbench((state) => state.runSnapshots[runId]);
  const pauseRun = useWorkbench((state) => state.pauseTeamRun);
  const resumeRun = useWorkbench((state) => state.resumeTeamRun);
  const cancelRun = useWorkbench((state) => state.cancelTeamRun);
  const [tab, setTab] = useState<RunTab>("tasks");
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);

  // Roving tabindex, like the workspace tools: one tab stop, arrows move and
  // select.
  const onTabKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const current = RUN_TABS.findIndex((name) => name === tab);
    let next: number | null = null;
    if (event.key === "ArrowRight") {
      next = (current + 1) % RUN_TABS.length;
    } else if (event.key === "ArrowLeft") {
      next = (current - 1 + RUN_TABS.length) % RUN_TABS.length;
    } else if (event.key === "Home") {
      next = 0;
    } else if (event.key === "End") {
      next = RUN_TABS.length - 1;
    }
    const target = next === null ? undefined : RUN_TABS[next];
    if (target) {
      event.preventDefault();
      setTab(target);
      tabRefs.current[next ?? 0]?.focus();
    }
  };

  // Hooks stay above the loading return so switching runs keeps their order.
  const tasksPage = usePagedList(snapshot?.tasks ?? EMPTY_LIST, `${runId}:tasks`);
  const messagesPage = usePagedList(snapshot?.messages ?? EMPTY_LIST, `${runId}:messages`);
  const artifactsPage = usePagedList(snapshot?.artifacts ?? EMPTY_LIST, `${runId}:artifacts`);
  const decisionsPage = usePagedList(snapshot?.decisions ?? EMPTY_LIST, `${runId}:decisions`);

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

      <div className="panel__tabs" role="tablist" aria-label="Run detail" onKeyDown={onTabKeyDown}>
        {RUN_TABS.map((name, index) => (
          <button
            type="button"
            key={name}
            role="tab"
            id={`run-${runId}-tab-${name}`}
            aria-selected={tab === name}
            aria-controls={`run-${runId}-panel`}
            tabIndex={tab === name ? 0 : -1}
            ref={(node) => {
              tabRefs.current[index] = node;
            }}
            className="panel__tab"
            onClick={() => setTab(name)}
          >
            {name.charAt(0).toUpperCase() + name.slice(1)}
          </button>
        ))}
      </div>

      <div role="tabpanel" id={`run-${runId}-panel`} aria-labelledby={`run-${runId}-tab-${tab}`}>
      {tab === "tasks" ? (
        <>
          <ListPager hidden={tasksPage.hidden} onShowMore={tasksPage.showMore} />
          <ul className="changes__list">
            {tasksPage.visible.length === 0 ? (
              <li className="row__meta">No tasks yet.</li>
            ) : (
              tasksPage.visible.map((task) => (
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
        </>
      ) : null}

      {tab === "agents" ? <AgentActivity snapshot={snapshot} providers={providers} /> : null}

      {tab === "messages" ? (
        <>
          <ListPager hidden={messagesPage.hidden} onShowMore={messagesPage.showMore} />
          <ul className="changes__list">
            {messagesPage.visible.length === 0 ? (
              <li className="row__meta">Nothing sent yet.</li>
            ) : (
              messagesPage.visible.map((message) => (
                <li className="changes__item" key={message.id}>
                  <span className="changes__badge">{message.type}</span>
                  <span className="row__text">
                    {message.from} → {message.to}: {message.content}
                  </span>
                </li>
              ))
            )}
          </ul>
        </>
      ) : null}

      {tab === "artifacts" ? (
        <>
          <ListPager hidden={artifactsPage.hidden} onShowMore={artifactsPage.showMore} />
          <ul className="changes__list">
            {artifactsPage.visible.length === 0 ? (
              <li className="row__meta">Nothing published yet.</li>
            ) : (
              artifactsPage.visible.map((artifact) => (
                <li className="changes__item" key={artifact.id}>
                  <span className="changes__badge">{artifact.type}</span>
                  <span className="row__text">{artifact.name}</span>
                  <span className="row__meta">{artifact.createdBy}</span>
                </li>
              ))
            )}
          </ul>
        </>
      ) : null}

      {tab === "decisions" ? (
        <>
          <ListPager hidden={decisionsPage.hidden} onShowMore={decisionsPage.showMore} />
          <ul className="changes__list">
            {decisionsPage.visible.length === 0 ? (
              <li className="row__meta">Nothing recorded yet.</li>
            ) : (
              decisionsPage.visible.map((decision) => (
                <li className="changes__item" key={decision.id}>
                  <span className="row__text">
                    {decision.title}: {decision.decision}
                  </span>
                  <span className="row__meta">{decision.author}</span>
                </li>
              ))
            )}
          </ul>
        </>
      ) : null}
      </div>
    </div>
  );
}

/** The compact per-agent summary from spec §93. */
function AgentActivity({
  snapshot,
  providers,
}: {
  readonly snapshot: TeamRunSnapshot;
  readonly providers: readonly ProviderSummary[];
}): JSX.Element {
  const teams = useWorkbench((state) => state.teams);

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
            <span className="row__meta">
              {" "}
              · <AgentProvider providerId={agent.providerId} providers={providers} />
            </span>
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

/** Provider mark plus account label, so two sign-ins of one tool differ. */
function AgentProvider({
  providerId,
  providers,
}: {
  readonly providerId: string;
  readonly providers: readonly ProviderSummary[];
}): JSX.Element {
  const provider = providers.find((entry) => entry.metadata.id === providerId);
  if (!provider) {
    return <>{providerId}</>;
  }
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
      <Logo
        name={provider.metadata.icon}
        label={provider.metadata.displayName}
        size={14}
      />
      {providerLabel(provider)}
    </span>
  );
}

interface AgentDraft {
  readonly key: number;
  name: string;
  role: string;
  providerId: string;
  modelId: string;
}

function NewTeamForm({ onDone }: { readonly onDone: () => void }): JSX.Element {
  const providers = useWorkbench((state) => state.providers);
  const createTeam = useWorkbench((state) => state.createTeam);
  const [name, setName] = useState("");
  const [agents, setAgents] = useState<AgentDraft[]>([
    { key: 1, name: "Lead", role: "plans and reviews", providerId: "", modelId: "" },
    { key: 2, name: "Builder", role: "implements", providerId: "", modelId: "" },
    { key: 3, name: "Reviewer", role: "checks the work", providerId: "", modelId: "" },
  ]);
  const keyRef = useRef(4);
  const [saving, setSaving] = useState(false);

  // Providers load after the form mounts; agents without a choice inherit the
  // first available one instead of staying empty. Hidden providers are never
  // offered for new agents.
  const firstProviderId =
    providers.find((entry) => entry.enabled)?.metadata.id ?? "";
  useEffect(() => {
    if (firstProviderId.length === 0) {
      return;
    }
    setAgents((current) =>
      current.map((agent) =>
        agent.providerId.length > 0 ? agent : { ...agent, providerId: firstProviderId },
      ),
    );
  }, [firstProviderId]);

  const patchAgent = (key: number, patch: Partial<AgentDraft>): void => {
    setAgents((current) =>
      current.map((agent) => {
        if (agent.key !== key) {
          return agent;
        }
        const next = { ...agent, ...patch };
        // A provider change drops a model the new provider does not offer.
        if (patch.providerId !== undefined) {
          const provider = providers.find((entry) => entry.metadata.id === patch.providerId);
          if (!provider?.models.some((model) => model.id === next.modelId)) {
            next.modelId = "";
          }
        }
        return next;
      }),
    );
  };

  const addAgent = (): void => {
    const key = keyRef.current;
    keyRef.current += 1;
    setAgents((current) => [
      ...current,
      { key, name: "", role: "", providerId: firstProviderId, modelId: "" },
    ]);
  };

  const removeAgent = (key: number): void => {
    setAgents((current) => (current.length <= 1 ? current : current.filter((agent) => agent.key !== key)));
  };

  const submit = async (): Promise<void> => {
    const roster = agents
      .map((agent) => ({
        displayName: agent.name.trim(),
        role: agent.role.trim(),
        providerId: agent.providerId || firstProviderId,
        modelId: agent.modelId,
      }))
      .filter((agent) => agent.displayName.length > 0 && agent.providerId.length > 0);

    if (name.trim().length === 0 || roster.length === 0) {
      return;
    }
    setSaving(true);
    try {
      await createTeam({ name: name.trim(), agents: roster });
      onDone();
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="provider-entry">
      <div className="provider-entry__head">
        <span className="provider-entry__name">New team</span>
        <span className="row__meta">First agent is the lead</span>
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
        {agents.map((agent, index) => (
          <AgentDraftRow
            key={agent.key}
            agent={agent}
            index={index}
            providers={providers}
            removable={agents.length > 1}
            onPatch={(patch) => patchAgent(agent.key, patch)}
            onRemove={() => removeAgent(agent.key)}
          />
        ))}
        <div className="scope-toggles">
          <button type="button" className="quiet-button" onClick={addAgent}>
            <Plus size={13} strokeWidth={1.75} aria-hidden="true" />
            Add agent
          </button>
          <button
            type="button"
            className="ghost-button"
            disabled={saving || name.trim().length === 0}
            onClick={() => void submit()}
          >
            {saving ? "Creating" : "Create team"}
          </button>
        </div>
      </div>
    </section>
  );
}

function AgentDraftRow({
  agent,
  index,
  providers,
  removable,
  onPatch,
  onRemove,
}: {
  readonly agent: AgentDraft;
  readonly index: number;
  readonly providers: readonly ProviderSummary[];
  readonly removable: boolean;
  readonly onPatch: (patch: Partial<AgentDraft>) => void;
  readonly onRemove: () => void;
}): JSX.Element {
  const provider = providers.find((entry) => entry.metadata.id === agent.providerId);
  const canSelectModel =
    (provider?.capabilities.supported.includes("modelSelection") ?? false) &&
    (provider?.models.length ?? 0) > 0;

  return (
    <fieldset className="agent-draft">
      <legend className="field__description">
        Agent {index + 1}
        {index === 0 ? " · lead" : ""}
      </legend>
      <div className="agent-draft__row">
        <label className="stacked-field">
          <span className="field__description">Name</span>
          <input
            className="text-input"
            value={agent.name}
            placeholder="Builder"
            onChange={(event) => onPatch({ name: event.target.value })}
          />
        </label>
        <label className="stacked-field">
          <span className="field__description">Role</span>
          <input
            className="text-input"
            value={agent.role}
            placeholder="implements"
            onChange={(event) => onPatch({ role: event.target.value })}
          />
        </label>
      </div>
      <div className="agent-draft__row">
        <label className="stacked-field">
          <span className="field__description">Provider</span>
          <select
            className="select"
            aria-label={`Provider for agent ${index + 1}`}
            value={agent.providerId}
            onChange={(event) => onPatch({ providerId: event.target.value })}
          >
            {providers
              .filter((entry) => entry.enabled || entry.metadata.id === agent.providerId)
              .map((entry) => (
                <option key={entry.metadata.id} value={entry.metadata.id}>
                  {providerLabel(entry)}
                </option>
              ))}
          </select>
        </label>
        {canSelectModel && provider ? (
          <label className="stacked-field">
            <span className="field__description">Model</span>
            <select
              className="select"
              aria-label={`Model for agent ${index + 1}`}
              value={agent.modelId}
              onChange={(event) => onPatch({ modelId: event.target.value })}
            >
              <option value="">Default model</option>
              {provider.models.map((model) => (
                <option key={model.id} value={model.id}>
                  {model.displayName}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        {removable ? (
          <button
            type="button"
            className="quiet-button"
            onClick={onRemove}
            aria-label={`Remove agent ${index + 1}`}
          >
            <Trash2 size={13} strokeWidth={1.75} aria-hidden="true" />
            Remove
          </button>
        ) : null}
      </div>
    </fieldset>
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
