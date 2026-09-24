import { useEffect, useRef, useState, type JSX, type KeyboardEvent } from "react";
import { FolderOpen, Pause, Pencil, Play, Plus, Square, Trash2 } from "lucide-react";
import type {
  ProviderSummary,
  TeamDefinition,
  TeamRun,
  TeamRunSnapshot,
  TeamTask,
} from "@ai-workbench/shared";
import { useWorkbench } from "../store/workbench.js";
import { Logo } from "./Logo.js";
import { Switch } from "./Controls.js";
import { MemberAvatar, runsOn } from "./TeamParts.js";
import { isPickableProvider, providerLabel } from "../lib/provider-label.js";

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
        <header className="view__header">
          <div className="view__heading">
            <h1 className="view__title">Teams</h1>
            <p className="view__lede">
              Agents that work on one goal together. Pick a team in any session, or start a run here.
            </p>
          </div>
          <div className="view__actions">
            <button
              type="button"
              className={creating ? "ghost-button" : "primary-button"}
              onClick={() => setCreating((open) => !open)}
            >
              {creating ? null : <Plus size={13} strokeWidth={2} aria-hidden="true" />}
              {creating ? "Cancel" : "New team"}
            </button>
          </div>
        </header>

        {creating ? <TeamForm onDone={() => setCreating(false)} /> : null}

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
  const openRun = useWorkbench((state) => state.openTeamRun);
  const [editing, setEditing] = useState(false);
  const [allRuns, setAllRuns] = useState(false);

  // Where a run started here writes. Shown, not implied: a team that runs in
  // the wrong folder is the one mistake that cannot be undone quietly.
  const activeWorkspace = useWorkbench((state) =>
    state.workspaces.find((entry) => entry.id === state.activeWorkspaceId),
  );
  const runsIn = team.settings.workingDirectory ?? activeWorkspace?.path ?? null;
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
    <article className="provider-entry team-card">
      <div className="team-card__head">
        <div className="team-card__title">
          <span className="provider-entry__name">{team.name}</span>
          {/* The compact state the specification asks for (spec §70). */}
          <span className="row__meta">
            {team.agents.length} agents · {active} active · {homeName}
          </span>
        </div>
        <div className="team-card__actions">
          <button
            type="button"
            className="quiet-button"
            aria-expanded={editing}
            onClick={() => setEditing((value) => !value)}
          >
            <Pencil size={13} strokeWidth={1.75} aria-hidden="true" />
            {editing ? "Close editor" : "Edit"}
          </button>
          <button
            type="button"
            className="quiet-button"
            data-tone="danger"
            onClick={() => void deleteTeam(team.id)}
          >
            <Trash2 size={13} strokeWidth={1.75} aria-hidden="true" />
            Remove
          </button>
        </div>
      </div>

      {editing ? <TeamForm team={team} onDone={() => setEditing(false)} /> : null}

      <ul className="team-card__members">
        {team.agents.map((agent) => (
          <li className="team-card__member" key={agent.id}>
            <MemberAvatar agent={agent} providers={providers} size={26} />
            <span className="team-card__member-text">
              <span className="team-card__member-name">
                {agent.displayName}
                {agent.id === team.leadAgentId ? <span className="team-member__lead">lead</span> : null}
              </span>
              <span className="team-card__member-role">
                {[runsOn(agent, providers), agent.role.trim()].filter(Boolean).join(" · ")}
              </span>
            </span>
          </li>
        ))}
      </ul>

      <div className="team-card__start">
        <input
          className="text-input"
          value={goal}
          aria-label={`Goal for ${team.name}`}
          placeholder="Give the team a goal…"
          onChange={(event) => setGoal(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              void begin();
            }
          }}
        />
        <button
          type="button"
          className="primary-button"
          disabled={starting || goal.trim().length === 0}
          onClick={() => void begin()}
        >
          <Play size={13} strokeWidth={1.75} aria-hidden="true" />
          {starting ? "Starting" : "Start run"}
        </button>
      </div>
      <p className="team-card__where">
        <FolderOpen size={12} strokeWidth={1.75} aria-hidden="true" />
        {team.settings.workingDirectory ? (
          <span>
            Always works in <span className="team-card__path">{team.settings.workingDirectory}</span>
          </span>
        ) : runsIn ? (
          <span>
            A run started here works in <span className="team-card__path">{runsIn}</span>; from a
            session, in the session&apos;s workspace.
          </span>
        ) : (
          <span>Open a workspace to start a run here; from a session, it runs in the session&apos;s workspace.</span>
        )}
      </p>

      {runs.length > 0 ? (
        <div className="section team-card__runs">
          <p className="section__label">Runs</p>
          {(allRuns ? runs : runs.slice(0, RECENT_RUNS)).map((run) => (
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
          {runs.length > RECENT_RUNS ? (
            <button type="button" className="link-button" onClick={() => setAllRuns((value) => !value)}>
              {allRuns ? "Show recent runs" : `Show all ${runs.length} runs`}
            </button>
          ) : null}
        </div>
      ) : null}

      {openRunId && runs.some((run) => run.id === openRunId) ? (
        <RunDetail runId={openRunId} providers={providers} />
      ) : null}
    </article>
  );
}

/** Runs a team card shows before "Show all". */
const RECENT_RUNS = 3;

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
  const [stopping, setStopping] = useState(false);
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
            disabled={stopping}
            onClick={() => {
              setStopping(true);
              void pauseRun(runId).finally(() => setStopping(false));
            }}
          >
            <Pause size={13} strokeWidth={1.75} aria-hidden="true" />
            {stopping ? "Pausing…" : "Pause"}
          </button>
        ) : run.status === "paused" ? (
          <button
            type="button"
            className="quiet-button"
            disabled={stopping}
            onClick={() => {
              setStopping(true);
              void resumeRun(runId).finally(() => setStopping(false));
            }}
          >
            <Play size={13} strokeWidth={1.75} aria-hidden="true" />
            {stopping ? "Working…" : "Resume"}
          </button>
        ) : null}
        {running || run.status === "paused" ? (
          <button
            type="button"
            className="quiet-button"
            disabled={stopping}
            onClick={() => {
              setStopping(true);
              void cancelRun(runId).finally(() => setStopping(false));
            }}
          >
            <Square size={13} strokeWidth={1.75} aria-hidden="true" />
            {stopping ? "Stopping…" : "Stop"}
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
  const progress = useWorkbench((state) => state.agentProgress);

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
            {agentActivity(
              agent.id,
              snapshot,
              progress[`${snapshot.run.id}:${agent.id}`]?.detail,
            )}
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

function agentActivity(
  agentId: string,
  snapshot: TeamRunSnapshot,
  liveDetail?: string,
): string {
  const current = snapshot.tasks.find(
    (task) =>
      task.assignedTo === agentId &&
      (task.status === "running" || task.status === "claimed"),
  );
  if (current) {
    // What the tool itself last reported wins over the task title, so a long
    // turn shows the agent's real work instead of only "Working on …".
    return liveDetail && liveDetail.length > 0
      ? `Working · ${liveDetail}`
      : `Working on ${current.title}`;
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
  /** The agent's id when it is already on the team. */
  readonly id?: string;
  name: string;
  role: string;
  providerId: string;
  modelId: string;
}

const NEW_TEAM: readonly Omit<AgentDraft, "key">[] = [
  { name: "Lead", role: "plans and reviews", providerId: "", modelId: "" },
  { name: "Builder", role: "implements", providerId: "", modelId: "" },
  { name: "Reviewer", role: "checks the work", providerId: "", modelId: "" },
];

/**
 * Creates a team, or edits one: its name, who is on it, what each member
 * runs on, who leads, and where it works. A team has no folder of its own
 * unless the person gives it one; a run works in the workspace it is started
 * from, which is the session's when it is started from a session.
 */
function TeamForm({
  team,
  onDone,
}: {
  readonly team?: TeamDefinition;
  readonly onDone: () => void;
}): JSX.Element {
  const providers = useWorkbench((state) => state.providers);
  const createTeam = useWorkbench((state) => state.createTeam);
  const updateTeam = useWorkbench((state) => state.updateTeam);
  const setWorkingDirectory = useWorkbench((state) => state.setTeamWorkingDirectory);
  const [name, setName] = useState(team?.name ?? "");
  const [instructions, setInstructions] = useState(team?.settings.instructions ?? "");
  const [agents, setAgents] = useState<AgentDraft[]>(() =>
    team
      ? team.agents.map((agent, index) => ({
          key: index + 1,
          id: agent.id,
          name: agent.displayName,
          role: agent.role,
          providerId: agent.providerId,
          modelId: agent.modelId ?? "",
        }))
      : NEW_TEAM.map((agent, index) => ({ ...agent, key: index + 1 })),
  );
  const [leadKey, setLeadKey] = useState<number>(() => {
    const index = team ? team.agents.findIndex((agent) => agent.id === team.leadAgentId) : 0;
    return (index >= 0 ? index : 0) + 1;
  });
  const [fixedFolder, setFixedFolder] = useState(team?.settings.workingDirectory ?? "");
  const [useFixed, setUseFixed] = useState(Boolean(team?.settings.workingDirectory));
  const [outside, setOutside] = useState(team?.settings.allowOutsideWorkspace ?? false);
  const keyRef = useRef(agents.length + 1);
  const [saving, setSaving] = useState(false);

  // Providers load after the form mounts; agents without a choice inherit the
  // first available one instead of staying empty. Hidden providers and ones
  // proven missing are never offered for new agents.
  const firstProviderId =
    providers.find((entry) => isPickableProvider(entry))?.metadata.id ?? "";
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
    if (leadKey === key) {
      setLeadKey(agents.find((agent) => agent.key !== key)?.key ?? 1);
    }
  };

  const submit = async (): Promise<void> => {
    const roster = agents.filter(
      (agent) => agent.name.trim().length > 0 && (agent.providerId || firstProviderId).length > 0,
    );
    if (name.trim().length === 0 || roster.length === 0) {
      return;
    }
    const leadIndex = Math.max(
      0,
      roster.findIndex((agent) => agent.key === leadKey),
    );
    setSaving(true);
    try {
      if (!team) {
        // The lead goes first: a new team's first member leads it.
        const ordered = [roster[leadIndex]!, ...roster.filter((_, index) => index !== leadIndex)];
        await createTeam({
          name: name.trim(),
          agents: ordered.map((agent) => ({
            displayName: agent.name.trim(),
            role: agent.role.trim(),
            providerId: agent.providerId || firstProviderId,
            modelId: agent.modelId,
          })),
        });
        onDone();
        return;
      }
      const updated = await updateTeam({
        teamId: team.id,
        name: name.trim(),
        instructions,
        leadAgentIndex: leadIndex,
        agents: roster.map((agent) => ({
          ...(agent.id ? { id: agent.id } : {}),
          displayName: agent.name.trim(),
          role: agent.role.trim(),
          providerId: agent.providerId || firstProviderId,
          ...(agent.modelId ? { modelId: agent.modelId } : {}),
        })),
      });
      const folder = useFixed && fixedFolder.trim().length > 0 ? fixedFolder.trim() : null;
      const folderChanged =
        folder !== (team.settings.workingDirectory ?? null) ||
        outside !== team.settings.allowOutsideWorkspace;
      const placed = folderChanged
        ? await setWorkingDirectory({
            teamId: team.id,
            workingDirectory: folder,
            allowOutsideWorkspace: outside,
          })
        : true;
      if (updated && placed) {
        onDone();
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="provider-entry team-form">
      <div className="provider-entry__head">
        <span className="provider-entry__name">{team ? `Edit ${team.name}` : "New team"}</span>
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
        {firstProviderId.length === 0 ? (
          <p className="field__description" role="note">
            No installed providers right now — install a tool or re-enable one
            under Providers to staff this team.
          </p>
        ) : null}
        {agents.map((agent, index) => (
          <AgentDraftRow
            key={agent.key}
            agent={agent}
            index={index}
            lead={agent.key === leadKey}
            providers={providers}
            removable={agents.length > 1}
            onPatch={(patch) => patchAgent(agent.key, patch)}
            onLead={() => setLeadKey(agent.key)}
            onRemove={() => removeAgent(agent.key)}
          />
        ))}
        <div className="scope-toggles">
          <button type="button" className="quiet-button" onClick={addAgent}>
            <Plus size={13} strokeWidth={1.75} aria-hidden="true" />
            Add agent
          </button>
        </div>

        {team ? (
          <>
            <label className="stacked-field">
              <span className="field__description">
                Instructions every member gets, on top of its role
              </span>
              <textarea
                className="text-input text-input--multiline"
                rows={2}
                value={instructions}
                placeholder="Keep changes small. Write tests first."
                onChange={(event) => setInstructions(event.target.value)}
              />
            </label>

            <fieldset className="agent-draft">
              <legend className="field__description">Where this team works</legend>
              <label className="radio-row">
                <input
                  type="radio"
                  name={`folder-${team.id}`}
                  checked={!useFixed}
                  onChange={() => setUseFixed(false)}
                />
                <span>
                  In the workspace a run is started from
                  <span className="field__description">
                    From a session, that is the session&apos;s workspace.
                  </span>
                </span>
              </label>
              <label className="radio-row">
                <input
                  type="radio"
                  name={`folder-${team.id}`}
                  checked={useFixed}
                  onChange={() => setUseFixed(true)}
                />
                <span>Always in one folder</span>
              </label>
              {useFixed ? (
                <>
                  <input
                    className="text-input"
                    value={fixedFolder}
                    placeholder="Absolute path"
                    spellCheck={false}
                    aria-label="Team folder"
                    onChange={(event) => setFixedFolder(event.target.value)}
                  />
                  <div className="setting setting--inline">
                    <div className="setting__text">
                      <p className="setting__label">Allow a folder outside the workspace</p>
                      <p className="setting__description">
                        Off, the folder must be inside the team&apos;s workspace.
                      </p>
                    </div>
                    <Switch
                      label="Allow a folder outside the workspace"
                      checked={outside}
                      onChange={setOutside}
                    />
                  </div>
                </>
              ) : null}
            </fieldset>
          </>
        ) : null}

        <div className="scope-toggles">
          <button
            type="button"
            className="ghost-button"
            disabled={saving || name.trim().length === 0}
            onClick={() => void submit()}
          >
            {saving ? "Saving" : team ? "Save team" : "Create team"}
          </button>
          <button type="button" className="quiet-button" onClick={onDone}>
            Cancel
          </button>
        </div>
      </div>
    </section>
  );
}

function AgentDraftRow({
  agent,
  index,
  lead,
  providers,
  removable,
  onPatch,
  onLead,
  onRemove,
}: {
  readonly agent: AgentDraft;
  readonly index: number;
  readonly lead: boolean;
  readonly providers: readonly ProviderSummary[];
  readonly removable: boolean;
  readonly onPatch: (patch: Partial<AgentDraft>) => void;
  readonly onLead: () => void;
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
        {lead ? " · lead" : ""}
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
              .filter((entry) => isPickableProvider(entry) || entry.metadata.id === agent.providerId)
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
        {lead ? null : (
          <button
            type="button"
            className="quiet-button"
            onClick={onLead}
            aria-label={`Make agent ${index + 1} the lead`}
          >
            Make lead
          </button>
        )}
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
