import type { JSX } from "react";
import type { TeamDefinition, TeamRunSnapshot } from "@ai-workbench/shared";
import { useWorkbench } from "../store/workbench.js";
import { useNow } from "../lib/usage.js";
import { Logo } from "./Logo.js";

/** How long a progress report counts as "doing this now". */
const LIVE_MS = 20_000;

/**
 * The right side of a team session: who is on the team, what each member
 * runs on, what it is doing, and the run in numbers. The same facts as the
 * run itself; nothing estimated.
 */
export function TeamPanel({
  team,
  snapshot,
}: {
  readonly team: TeamDefinition;
  readonly snapshot: TeamRunSnapshot | null;
}): JSX.Element {
  const progress = useWorkbench((state) => state.agentProgress);
  const providers = useWorkbench((state) => state.providers);
  const setView = useWorkbench((state) => state.setView);
  const now = useNow(5_000);
  const run = snapshot?.run ?? null;
  const going = run?.status === "running" || run?.status === "pending";
  const done = snapshot?.tasks.filter((task) => task.status === "completed").length ?? 0;
  const failed = snapshot?.tasks.filter((task) => task.status === "failed").length ?? 0;

  return (
    <aside className="context team-panel" aria-label="Team">
      <div className="context__section">
        <p className="context__heading">Members</p>
        <ul className="team-roster">
          {team.agents.map((agent) => {
            const provider = providers.find((entry) => entry.metadata.id === agent.providerId);
            const model = provider?.models.find((entry) => entry.id === agent.modelId);
            const report = run ? progress[`${run.id}:${agent.id}`] : undefined;
            const live = report && going && now - report.at < LIVE_MS ? report.detail : null;
            const task = snapshot?.tasks.find(
              (entry) =>
                entry.assignedTo === agent.id &&
                (entry.status === "running" || entry.status === "claimed"),
            );
            const state = live ? "running" : task ? "waiting" : "idle";
            return (
              <li className="team-roster__member" key={agent.id}>
                <span className="logo-well logo-well--sm" aria-hidden="true">
                  <Logo
                    name={provider?.metadata.icon ?? agent.providerId}
                    label={provider?.metadata.displayName ?? agent.providerId}
                    size={13}
                  />
                </span>
                <span className="team-roster__text">
                  <span className="team-roster__name">
                    {agent.displayName}
                    {agent.id === team.leadAgentId ? <span className="team-roster__lead">lead</span> : null}
                  </span>
                  <span className="team-roster__runs">
                    {provider?.metadata.displayName ?? agent.providerId}
                    {agent.modelId ? ` · ${model?.displayName ?? agent.modelId}` : ""}
                  </span>
                  <span className="team-roster__state" data-state={state}>
                    <span className="status-dot" data-state={state} aria-hidden="true" />
                    {live ?? (task ? task.title : run ? "idle" : "ready")}
                  </span>
                </span>
              </li>
            );
          })}
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
              <dt>Tasks</dt>
              <dd>
                {done} of {snapshot.tasks.length} done{failed > 0 ? ` · ${failed} failed` : ""}
              </dd>
            </div>
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

/** The run's own reason, in words a person reads. */
function stopReasonLabel(reason: string): string {
  switch (reason) {
    case "goalFinished":
      return "goal finished";
    case "cancelled":
      return "stopped";
    case "paused":
      return "paused";
    case "noWorkLeft":
      return "no work left";
    case "tooManyFailures":
      return "too many failures";
    case "maxAgentCalls":
      return "call limit reached";
    default:
      return reason.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase();
  }
}
