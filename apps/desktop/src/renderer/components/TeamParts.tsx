import type { JSX } from "react";
import { CircleCheck, CircleDashed, CircleSlash, CircleX, LoaderCircle } from "lucide-react";
import type {
  AgentDefinition,
  ProviderSummary,
  TeamDefinition,
  TeamRun,
  TeamRunSnapshot,
  TeamRunStopReason,
  TeamTask,
} from "@ai-workbench/shared";
import { useWorkbench } from "../store/workbench.js";
import { useNow } from "../lib/usage.js";
import { Logo } from "./Logo.js";

/**
 * The pieces a team session and its side panel share: how a member looks,
 * where it stands, and how a task's state reads. Every state comes from the
 * run itself — its tasks and the members' own progress reports.
 */

/** How long a progress report counts as "doing this now". */
const LIVE_MS = 20_000;

export type MemberState = "running" | "waiting" | "idle" | "error";

/** What each member reported doing, while the report is fresh and the run is going. */
export function useLiveReports(run: TeamRun | null): (agentId: string) => string | null {
  const progress = useWorkbench((state) => state.agentProgress);
  const now = useNow(5_000);
  const going = run?.status === "running" || run?.status === "pending";
  return (agentId) => {
    if (!run || !going) {
      return null;
    }
    const entry = progress[`${run.id}:${agentId}`];
    return entry && now - entry.at < LIVE_MS ? entry.detail : null;
  };
}

export function isGoing(run: TeamRun | null): boolean {
  return run?.status === "running" || run?.status === "pending";
}

export function memberStateOf(
  agentId: string,
  snapshot: TeamRunSnapshot | null,
  live: string | null,
): MemberState {
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

/** One short line on where a member stands. */
export function memberLine(agentId: string, snapshot: TeamRunSnapshot | null, live: string | null): string {
  if (!snapshot) {
    return "Ready";
  }
  if (live) {
    return live;
  }
  const tasks = snapshot.tasks.filter((entry) => entry.assignedTo === agentId);
  const current = tasks.find((entry) => entry.status === "running" || entry.status === "claimed");
  if (current) {
    return current.title;
  }
  const done = tasks.filter((entry) => entry.status === "completed").length;
  const failed = tasks.filter((entry) => entry.status === "failed").length;
  if (done === 0 && failed === 0) {
    return isGoing(snapshot.run) ? "Waiting for work" : "No tasks";
  }
  return [done > 0 ? `${done} done` : "", failed > 0 ? `${failed} failed` : ""].filter(Boolean).join(" · ");
}

/** A member's initials, so a face stays recognisable at a small size. */
function initialsOf(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) {
    return "?";
  }
  const first = words[0]?.charAt(0) ?? "";
  const second = words.length > 1 ? (words[words.length - 1]?.charAt(0) ?? "") : "";
  return (first + second).toUpperCase();
}

/**
 * A member's face: its initials, a ring in the colour of its state, and the
 * logo of the tool it runs on.
 */
export function MemberAvatar({
  agent,
  providers,
  state = "idle",
  size = 28,
  you = false,
}: {
  /** Null for someone no longer on the team. */
  readonly agent: AgentDefinition | null;
  readonly providers: readonly ProviderSummary[];
  readonly state?: MemberState;
  readonly size?: number;
  /** The person, writing to the team. */
  readonly you?: boolean;
}): JSX.Element {
  const style = { width: size, height: size, fontSize: Math.round(size * 0.36) };
  if (you || !agent) {
    return (
      <span className="avatar" data-state={you ? "you" : "idle"} style={style} aria-hidden="true">
        {you ? "You" : "?"}
      </span>
    );
  }
  const provider = providers.find((entry) => entry.metadata.id === agent.providerId);
  return (
    <span className="avatar" data-state={state} style={style} aria-hidden="true">
      {initialsOf(agent.displayName)}
      <span className="avatar__tool">
        <Logo
          name={provider?.metadata.icon ?? agent.providerId}
          label={provider?.metadata.displayName ?? agent.providerId}
          size={Math.max(9, Math.round(size * 0.36))}
        />
      </span>
    </span>
  );
}

/** What a member runs on, in words: "Claude Code · Sonnet". */
export function runsOn(agent: AgentDefinition, providers: readonly ProviderSummary[]): string {
  const provider = providers.find((entry) => entry.metadata.id === agent.providerId);
  const model = provider?.models.find((entry) => entry.id === agent.modelId);
  return `${provider?.metadata.displayName ?? agent.providerId}${
    agent.modelId ? ` · ${model?.displayName ?? agent.modelId}` : ""
  }`;
}

export function TaskIcon({ task }: { readonly task: TeamTask }): JSX.Element {
  const props = { size: 14, strokeWidth: 1.75, "aria-hidden": true as const };
  switch (task.status) {
    case "completed":
      return (
        <span className="task-icon" data-status="completed">
          <CircleCheck {...props} />
        </span>
      );
    case "failed":
      return (
        <span className="task-icon" data-status="failed">
          <CircleX {...props} />
        </span>
      );
    case "running":
    case "claimed":
      return (
        <span className="task-icon" data-status="running">
          <LoaderCircle {...props} />
        </span>
      );
    case "cancelled":
    case "blocked":
      return (
        <span className="task-icon" data-status="stopped">
          <CircleSlash {...props} />
        </span>
      );
    default:
      return (
        <span className="task-icon" data-status="waiting">
          <CircleDashed {...props} />
        </span>
      );
  }
}

export function taskLabel(task: TeamTask): string {
  switch (task.status) {
    case "completed":
      return "Done";
    case "failed":
      return "Failed";
    case "running":
    case "claimed":
      return "Working";
    case "blocked":
      return "Blocked";
    case "cancelled":
      return "Cancelled";
    default:
      return "Waiting";
  }
}

export function runLabel(run: TeamRun): string {
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

export function runTone(run: TeamRun): string {
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

/** The run's own reason for stopping, in words a person reads. */
export function stopReasonLabel(reason: TeamRunStopReason): string {
  switch (reason) {
    case "goalFinished":
      return "Goal finished";
    case "cancelled":
      return "Stopped";
    case "paused":
      return "Paused";
    case "noWorkLeft":
      return "No work left";
    case "tooManyFailures":
      return "Too many failures";
    case "limitReached":
      return "Limit reached";
  }
}

/**
 * Text the run recorded names members by their ids; a person reads their
 * names instead.
 */
export function withNames(text: string, team: TeamDefinition): string {
  let named = text;
  for (const agent of team.agents) {
    if (agent.id.length > 3) {
      named = named.split(agent.id).join(agent.displayName);
    }
  }
  return named;
}

/** "4 min", "1 h 5 min": how long a run has taken. */
export function durationLabel(from: Date, to: Date): string {
  const minutes = Math.max(0, Math.round((to.getTime() - from.getTime()) / 60_000));
  if (minutes < 1) {
    return "under a minute";
  }
  if (minutes < 60) {
    return `${minutes} min`;
  }
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest > 0 ? `${hours} h ${rest} min` : `${hours} h`;
}
