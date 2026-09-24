import { useMemo, type JSX } from "react";
import type { TeamDefinition, TeamRunSnapshot, TeamTask } from "@ai-workbench/shared";
import { compactNumber } from "../lib/format.js";
import { useWorkbench } from "../store/workbench.js";
import {
  remainingStatus,
  taskDurationMs,
  taskTokens,
  teamRunStats,
} from "../lib/task-stats.js";
import { formatSpan, useNow } from "../lib/usage.js";
import {
  MemberAvatar,
  TaskIcon,
  memberStateOf,
  runsOn,
  stopReasonLabel,
  taskLabel,
  useLiveReports,
} from "./TeamParts.js";

/**
 * The right side of a team session: the plan as the run holds it — every
 * task, where it stands and who has it — then who is on the team and the run
 * in numbers. The same facts as the run itself; nothing estimated.
 */
export function TeamPanel({
  team,
  snapshot,
}: {
  readonly team: TeamDefinition;
  readonly snapshot: TeamRunSnapshot | null;
}): JSX.Element {
  const providers = useWorkbench((state) => state.providers);
  const usage = useWorkbench((state) => state.usage);
  const setView = useWorkbench((state) => state.setView);
  const run = snapshot?.run ?? null;
  const live = useLiveReports(run);
  const now = useNow(5_000);
  const tasks = snapshot ? planOrder(snapshot.tasks) : [];
  const done = tasks.filter((entry) => entry.task.status === "completed").length;
  // Run numbers from the run itself: durations from timestamps, tokens only
  // from turns whose tools reported them, remaining from what the members'
  // tools reported. Anything missing reads unknown/unverified, never a guess.
  const stats = useMemo(
    () => (snapshot ? teamRunStats(snapshot, now) : null),
    [snapshot, now],
  );
  const memberProviderIds = useMemo(
    () => [...new Set(team.agents.map((agent) => agent.providerId))],
    [team],
  );
  const remaining = useMemo(
    () => remainingStatus({ usage, providers, providerIds: memberProviderIds, now }),
    [usage, providers, memberProviderIds, now],
  );
  const nameOf = (id: string | null): string | null =>
    id ? (team.agents.find((agent) => agent.id === id)?.displayName ?? null) : null;

  return (
    <aside className="context team-panel" aria-label="Team">
      <div className="context__section">
        <p className="context__heading">
          Plan
          {tasks.length > 0 ? (
            <span className="context__count">
              {done}/{tasks.length}
            </span>
          ) : null}
        </p>
        {tasks.length === 0 ? (
          <p className="team-plan__empty">
            {run ? "The lead is planning the work." : "Once the team has a goal, its lead breaks it into tasks here."}
          </p>
        ) : (
          <ol className="team-plan">
            {tasks.map(({ task, depth }) => (
              <TaskRow
                key={task.id}
                task={task}
                depth={depth}
                assignee={nameOf(task.assignedTo)}
                snapshot={snapshot}
                now={now}
              />
            ))}
          </ol>
        )}
      </div>

      <div className="context__section">
        <p className="context__heading">Members</p>
        <ul className="team-roster">
          {team.agents.map((agent) => (
            <li className="team-roster__member" key={agent.id}>
              <MemberAvatar
                agent={agent}
                providers={providers}
                state={memberStateOf(agent.id, snapshot, live(agent.id))}
                size={24}
              />
              <span className="team-roster__text">
                <span className="team-roster__name">
                  {agent.displayName}
                  {agent.id === team.leadAgentId ? <span className="team-member__lead">lead</span> : null}
                </span>
                <span className="team-roster__runs">{runsOn(agent, providers)}</span>
              </span>
            </li>
          ))}
        </ul>
        <button type="button" className="link-button" onClick={() => setView("teams")}>
          Edit team
        </button>
      </div>

      {snapshot && run ? (
        <div className="context__section">
          <p className="context__heading">Run</p>
          <dl className="team-stats">
            <div>
              <dt>Agent calls</dt>
              <dd>
                {run.agentCalls} of {run.limits.maxAgentCalls}
              </dd>
            </div>
            <div>
              <dt>Messages</dt>
              <dd>{snapshot.messages.length}</dd>
            </div>
            {run.failures > 0 ? (
              <div>
                <dt>Failures</dt>
                <dd>
                  {run.failures} of {run.limits.maxFailures}
                </dd>
              </div>
            ) : null}
            {stats?.runDurationMs !== null && stats ? (
              <div>
                <dt>Working time</dt>
                <dd title="Wall-clock from the run's own start, as recorded">
                  {formatSpan(stats.runDurationMs)}
                </dd>
              </div>
            ) : null}
            <div>
              <dt>Tokens</dt>
              <dd
                title={
                  stats && stats.tokens !== null
                    ? `${stats.tokens.toLocaleString()} reported across ${stats.turnsWithUsage} of ${stats.turnsTotal} turns`
                    : "No member's tool reported token usage yet"
                }
              >
                {stats?.tokens !== null && stats ? compactNumber(stats.tokens) : "unknown"}
              </dd>
            </div>
            <div>
              <dt>Remaining</dt>
              <dd
                title={
                  remaining.kind === "ready"
                    ? remaining.detail
                    : remaining.kind === "unverified"
                      ? remaining.reason
                      : "No member's tool reported usage yet"
                }
              >
                {remaining.kind === "ready"
                  ? `${remaining.percentUsed}% used`
                  : remaining.kind === "unknown"
                    ? "unknown"
                    : "unverified"}
              </dd>
            </div>
            {run.stopReason ? (
              <div>
                <dt>Ended</dt>
                <dd>{stopReasonLabel(run.stopReason)}</dd>
              </div>
            ) : null}
          </dl>
        </div>
      ) : null}
    </aside>
  );
}

/**
 * One task in the plan: state, title, who has it, and — once the run recorded
 * them — how long it took and what its turns reported. Durations come from the
 * task's own timestamps; tokens only from reported turn usage, so a task whose
 * tools said nothing shows its time and no token number rather than a zero.
 */
function TaskRow({
  task,
  depth,
  assignee,
  snapshot,
  now,
}: {
  readonly task: TeamTask;
  readonly depth: number;
  readonly assignee: string | null;
  readonly snapshot: TeamRunSnapshot | null;
  readonly now: number;
}): JSX.Element {
  const duration = taskDurationMs(task, now);
  const tokens = snapshot ? taskTokens(snapshot, task.id) : null;
  const meta =
    duration !== null && tokens !== null
      ? `${formatSpan(duration)} · ${compactNumber(tokens)} tokens`
      : duration !== null
        ? formatSpan(duration)
        : null;
  const title = `${task.title}\n${taskLabel(task)}${assignee ? ` · ${assignee}` : ""}${
    duration !== null ? ` · took ${formatSpan(duration)}` : ""
  }${tokens !== null ? ` · ${tokens.toLocaleString()} tokens reported` : ""}`;
  return (
    <li
      className="team-plan__task"
      data-status={task.status}
      style={{ paddingLeft: Math.min(depth, 3) * 14 }}
      title={title}
    >
      <TaskIcon task={task} />
      <span className="team-plan__text">
        <span className="team-plan__title">{task.title}</span>
        {assignee || meta ? (
          <span className="team-plan__who">
            {[assignee, meta].filter(Boolean).join(" · ")}
          </span>
        ) : null}
      </span>
    </li>
  );
}

/**
 * Tasks as a plan reads: each after the task it came from, in the order they
 * were made.
 */
function planOrder(tasks: readonly TeamTask[]): { task: TeamTask; depth: number }[] {
  const byParent = new Map<string | null, TeamTask[]>();
  const ids = new Set(tasks.map((task) => task.id));
  for (const task of [...tasks].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())) {
    const parent = task.parentTaskId && ids.has(task.parentTaskId) ? task.parentTaskId : null;
    byParent.set(parent, [...(byParent.get(parent) ?? []), task]);
  }
  const ordered: { task: TeamTask; depth: number }[] = [];
  const visit = (parent: string | null, depth: number): void => {
    for (const task of byParent.get(parent) ?? []) {
      ordered.push({ task, depth });
      visit(task.id, depth + 1);
    }
  };
  visit(null, 0);
  // A task whose parents point at each other still belongs in the plan.
  const placed = new Set(ordered.map((entry) => entry.task.id));
  for (const task of tasks) {
    if (!placed.has(task.id)) {
      ordered.push({ task, depth: 0 });
    }
  }
  return ordered;
}
