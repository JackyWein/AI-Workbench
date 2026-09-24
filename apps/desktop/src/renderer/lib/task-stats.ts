import type {
  AggregatedUsage,
  ChatMessage,
  MessageUsage,
  ProviderSummary,
  TeamRunSnapshot,
  TeamTask,
} from "@ai-workbench/shared";
import { tightestLimit } from "./usage.js";

/** What one solo session cost so far, summed from what the tool reported. */
export interface SoloStats {
  readonly turns: number;
  readonly durationMs: number;
  readonly input: number;
  readonly output: number;
  readonly cached: number;
  readonly tokens: number;
  readonly costUsd: number | null;
  readonly context: { used: number; window: number | undefined } | null;
}

/** Sums what the tool reported for each answer of the session. */
export function soloSessionStats(messages: readonly ChatMessage[]): SoloStats {
  let turns = 0;
  let durationMs = 0;
  let input = 0;
  let output = 0;
  let cached = 0;
  let costUsd: number | null = null;
  let latest: MessageUsage | null = null;
  for (const message of messages) {
    if (message.role !== "assistant") {
      continue;
    }
    turns += 1;
    const usage = message.usage;
    if (!usage) {
      continue;
    }
    latest = usage;
    durationMs += usage.durationMs ?? 0;
    input += (usage.inputTokens ?? 0) + (usage.cacheWriteTokens ?? 0);
    cached += usage.cacheReadTokens ?? 0;
    output += usage.outputTokens ?? 0;
    if (usage.costUsd !== undefined) {
      costUsd = (costUsd ?? 0) + usage.costUsd;
    }
  }
  const context =
    latest?.contextTokens !== undefined
      ? { used: latest.contextTokens, window: latest.contextWindow }
      : null;
  return {
    turns,
    durationMs,
    input,
    output,
    cached,
    tokens: input + output + cached,
    costUsd,
    context,
  };
}

/**
 * How long one team task took, from the run's own timestamps — never a guess.
 * Finished tasks read startedAt→completedAt; a task still going reads
 * startedAt→now so a live row keeps counting; anything else is null, which the
 * UI renders as "unknown" rather than a zero.
 */
export function taskDurationMs(task: TeamTask, now: number): number | null {
  const started = task.startedAt?.getTime();
  if (started === undefined) {
    return null;
  }
  if (task.completedAt) {
    return Math.max(0, task.completedAt.getTime() - started);
  }
  if (task.status === "running" || task.status === "claimed") {
    return Math.max(0, now - started);
  }
  return null;
}

/** A turn may carry what its tool reported; older turns carry nothing. */
type TurnWithUsage = {
  readonly taskId: string | null;
  readonly startedAt: Date;
  readonly finishedAt: Date | null;
  readonly usage?: MessageUsage | null;
};

function turnUsageOf(turn: { readonly usage?: unknown }): MessageUsage | null {
  const usage = turn.usage as MessageUsage | null | undefined;
  return usage ?? null;
}

function turnTokens(usage: MessageUsage): number {
  return (
    (usage.inputTokens ?? 0) +
    (usage.outputTokens ?? 0) +
    (usage.cacheReadTokens ?? 0) +
    (usage.cacheWriteTokens ?? 0)
  );
}

/** What a team run cost so far: durations from timestamps, tokens only when reported. */
export interface TeamStats {
  readonly tasksTotal: number;
  readonly tasksDone: number;
  /** Run wall-clock: startedAt→finishedAt, or startedAt→now while going. Null before it starts. */
  readonly runDurationMs: number | null;
  /** Sum of per-task durations that are known; null when none is. */
  readonly taskTimeMs: number | null;
  /** Sum of tokens the members' tools reported; null when none reported any. */
  readonly tokens: number | null;
  /** How many turns reported usage, of how many turns there are. */
  readonly turnsWithUsage: number;
  readonly turnsTotal: number;
}

/**
 * Derives run stats from a snapshot. Token totals stay null until a turn
 * carries usage — the UI then says "unknown" instead of showing a zero the
 * providers never reported.
 */
export function teamRunStats(
  snapshot: TeamRunSnapshot,
  now: number,
): TeamStats {
  const tasks = snapshot.tasks;
  const tasksDone = tasks.filter((entry) => entry.status === "completed").length;
  const run = snapshot.run;
  const runDurationMs =
    run.startedAt !== null
      ? run.finishedAt !== null
        ? Math.max(0, run.finishedAt.getTime() - run.startedAt.getTime())
        : run.status === "running" || run.status === "pending"
          ? Math.max(0, now - run.startedAt.getTime())
          : null
      : null;

  let taskTimeMs = 0;
  let taskTimeKnown = false;
  for (const task of tasks) {
    const duration = taskDurationMs(task, now);
    if (duration !== null) {
      taskTimeKnown = true;
      taskTimeMs += duration;
    }
  }

  let tokens = 0;
  let turnsWithUsage = 0;
  const turns = (snapshot.turns ?? []) as readonly TurnWithUsage[];
  for (const turn of turns) {
    const usage = turnUsageOf(turn);
    if (!usage) {
      continue;
    }
    turnsWithUsage += 1;
    tokens += turnTokens(usage);
  }

  return {
    tasksTotal: tasks.length,
    tasksDone,
    runDurationMs,
    taskTimeMs: taskTimeKnown ? taskTimeMs : null,
    tokens: turnsWithUsage > 0 ? tokens : null,
    turnsWithUsage,
    turnsTotal: turns.length,
  };
}

/**
 * Tokens one task's turns reported; null when none did. Forward-compatible:
 * turns from before usage was recorded simply contribute nothing.
 */
export function taskTokens(
  snapshot: TeamRunSnapshot,
  taskId: string,
): number | null {
  let tokens = 0;
  let known = false;
  for (const turn of (snapshot.turns ?? []) as readonly TurnWithUsage[]) {
    if (turn.taskId !== taskId) {
      continue;
    }
    const usage = turnUsageOf(turn);
    if (!usage) {
      continue;
    }
    known = true;
    tokens += turnTokens(usage);
  }
  return known ? tokens : null;
}

export type RemainingStatus =
  | { readonly kind: "ready"; readonly percentUsed: number; readonly label: string; readonly detail: string }
  | { readonly kind: "unknown" }
  | { readonly kind: "unverified"; readonly reason: string };

/**
 * Remaining quota across the given providers, read — never written.
 * Provider-independent: callers pass ids, this checks each provider's own
 * `capabilities.supported` for "usage" instead of branching on identity.
 * - no capable provider → "unverified"
 * - capable but nothing reported → "unknown"
 * - a snapshot that says unavailable → "unverified" with its note
 */
export function remainingStatus(input: {
  readonly usage: AggregatedUsage | null;
  readonly providers: readonly ProviderSummary[];
  readonly providerIds: readonly string[];
  readonly now: number;
}): RemainingStatus {
  const capable = new Set(
    input.providers
      .filter(
        (provider) =>
          input.providerIds.includes(provider.metadata.id) &&
          provider.capabilities.supported.includes("usage"),
      )
      .map((provider) => provider.metadata.id),
  );
  if (capable.size === 0) {
    return { kind: "unverified", reason: "does not report usage" };
  }
  const tightest = tightestLimit(input.usage, capable, input.now);
  if (tightest) {
    const providerName =
      input.providers.find((entry) => entry.metadata.id === tightest.providerId)
        ?.metadata.displayName ?? tightest.providerId;
    const remaining =
      tightest.limit.remaining !== undefined && tightest.limit.total !== undefined
        ? ` · ${tightest.limit.remaining.toLocaleString()} of ${tightest.limit.total.toLocaleString()} left`
        : tightest.limit.resetsText
          ? ` · resets ${tightest.limit.resetsText}`
          : tightest.limit.resetsAt
            ? ` · resets ${tightest.limit.resetsAt.toLocaleString()}`
            : "";
    return {
      kind: "ready",
      percentUsed: tightest.percentUsed,
      label: `${tightest.percentUsed}% used · ${providerName} · ${tightest.limit.label.toLowerCase()}${remaining}`,
      detail: `${providerName} · ${tightest.limit.label}: ${tightest.percentUsed}% used${remaining}`,
    };
  }
  const snapshots = input.usage?.snapshots.filter((snapshot) =>
    capable.has(snapshot.providerId),
  ) ?? [];
  const unavailable = snapshots.find((snapshot) => snapshot.state === "unavailable");
  if (unavailable?.note) {
    return { kind: "unverified", reason: unavailable.note };
  }
  if (snapshots.length > 0) {
    return { kind: "unverified", reason: "usage unavailable" };
  }
  return { kind: "unknown" };
}

/** The one word the UI shows for a RemainingStatus value. */
export function remainingShort(status: RemainingStatus): string {
  switch (status.kind) {
    case "ready":
      return `${status.percentUsed}% used`;
    case "unknown":
      return "unknown";
    case "unverified":
      return "unverified";
  }
}
