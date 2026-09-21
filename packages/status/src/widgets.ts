import {
  ISLAND_PRIORITY,
  type AggregatedUsage,
  type IslandTarget,
  type UsageLimit,
  type IslandEntry,
  type IslandWidgetId,
  type TeamRunSnapshot,
} from "@ai-workbench/shared";

/**
 * The widget registry (spec §98).
 *
 * A widget turns whatever the application currently knows into at most one
 * island entry. It reports nothing when it has nothing to say, which is how the
 * island stays quiet, and it never estimates: a percentage appears only where
 * there are real items to count (spec §103).
 */
export interface IslandSources {
  readonly usage: AggregatedUsage | null;
  /** Runs the application is driving right now. */
  readonly runs: readonly TeamRunSnapshot[];
  /** Sessions that are mid-answer, with the state they reported. */
  readonly busySessions: ReadonlyArray<{
    sessionId: string;
    name: string;
    status: string;
    /**
     * Where "Open" lands. Defaults to the session's chat; tiles and shells
     * that belong to no chat point at the chat view instead of a bad id.
     */
    target?: IslandTarget;
  }>;
  /** Things waiting on a person, newest first (spec §99). */
  readonly attention: ReadonlyArray<{
    key: string;
    title: string;
    detail: string;
    runId?: string;
    sessionId?: string;
    at: Date;
  }>;
  /** Failures worth surfacing, newest first. */
  readonly errors: ReadonlyArray<{
    key: string;
    title: string;
    detail: string;
    sessionId?: string;
    runId?: string;
    at: Date;
  }>;
  /** Connections the application knows are down. */
  readonly brokenConnections: ReadonlyArray<{ key: string; title: string; detail: string }>;
  /** Work that finished recently, newest first. */
  readonly completed: ReadonlyArray<{
    key: string;
    title: string;
    detail: string;
    runId?: string;
    at: Date;
  }>;
  readonly now: Date;
}

export interface IslandWidget {
  readonly id: IslandWidgetId;
  readonly displayName: string;
  /** At most one entry, or null when this widget has nothing to report. */
  build(sources: IslandSources): IslandEntry | null;
}

function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}

/** How much of a limit is used, or null when the provider did not say. */
function usedPercent(limit: UsageLimit): number | null {
  if (limit.unit === "percent") {
    if (limit.used !== undefined) {
      return Math.round(Math.min(100, Math.max(0, limit.used)));
    }
    if (limit.remaining !== undefined) {
      return Math.round(Math.min(100, Math.max(0, 100 - limit.remaining)));
    }
    return null;
  }
  if (limit.total === undefined || limit.total <= 0) {
    return null;
  }
  const used =
    limit.used ?? (limit.remaining === undefined ? undefined : limit.total - limit.remaining);
  if (used === undefined) {
    return null;
  }
  return Math.round(Math.min(100, Math.max(0, (used / limit.total) * 100)));
}

export const needsAttentionWidget: IslandWidget = {
  id: "needsAttention",
  displayName: "Needs attention",
  build(sources) {
    const first = sources.attention[0];
    if (!first) {
      return null;
    }
    return {
      widget: "needsAttention",
      priority: ISLAND_PRIORITY.userActionRequired,
      title: first.title,
      detail:
        sources.attention.length > 1
          ? `${first.detail} · ${sources.attention.length - 1} more waiting`
          : first.detail,
      progress: null,
      action: {
        label: "Open",
        target: first.runId
          ? { view: "teams", runId: first.runId }
          : first.sessionId
            ? { view: "chat", sessionId: first.sessionId }
            : { view: "chat" },
      },
      key: first.key,
      at: first.at,
    };
  },
};

export const errorsWidget: IslandWidget = {
  id: "errors",
  displayName: "Errors",
  build(sources) {
    const first = sources.errors[0];
    if (!first) {
      return null;
    }
    return {
      widget: "errors",
      priority: ISLAND_PRIORITY.agentBlocked,
      title: first.title,
      detail: first.detail,
      progress: null,
      action: {
        label: "Open",
        target: first.runId
          ? { view: "teams", runId: first.runId }
          : first.sessionId
            ? { view: "chat", sessionId: first.sessionId }
            : { view: "chat" },
      },
      key: first.key,
      at: first.at,
    };
  },
};

export const connectionHealthWidget: IslandWidget = {
  id: "connectionHealth",
  displayName: "Connection health",
  build(sources) {
    const first = sources.brokenConnections[0];
    if (!first) {
      return null;
    }
    return {
      widget: "connectionHealth",
      priority: ISLAND_PRIORITY.connectionFailure,
      title: first.title,
      detail: first.detail,
      progress: null,
      action: { label: "Open", target: { view: "mcp" } },
      key: first.key,
      at: sources.now,
    };
  },
};

/**
 * How long a completion stays news. Attention and errors are states and last
 * until they are resolved; a finished run is an event, so the island settles
 * back rather than announcing it forever (spec §97).
 */
export const COMPLETED_WORK_WINDOW_MS = 5 * 60_000;

export const completedWorkWidget: IslandWidget = {
  id: "completedWork",
  displayName: "Completed work",
  build(sources) {
    const first = sources.completed.find(
      (entry) => sources.now.getTime() - entry.at.getTime() < COMPLETED_WORK_WINDOW_MS,
    );
    if (!first) {
      return null;
    }
    return {
      widget: "completedWork",
      priority: ISLAND_PRIORITY.workCompleted,
      title: first.title,
      detail: first.detail,
      progress: null,
      action: first.runId
        ? { label: "Open", target: { view: "teams", runId: first.runId } }
        : null,
      key: first.key,
      at: first.at,
    };
  },
};

export const teamProgressWidget: IslandWidget = {
  id: "teamProgress",
  displayName: "Team progress",
  build(sources) {
    const running = sources.runs.filter((snapshot) => snapshot.run.status === "running");
    const snapshot = running[0];
    if (!snapshot) {
      return null;
    }
    const total = snapshot.tasks.length;
    const completed = snapshot.tasks.filter((task) => task.status === "completed").length;

    return {
      widget: "teamProgress",
      priority: ISLAND_PRIORITY.activeProgress,
      title: snapshot.run.goal,
      // Counted, never estimated. With no tasks yet there is no percentage to
      // give, and saying so is the honest answer (spec §103).
      detail:
        total === 0
          ? "Planning"
          : `${completed} of ${plural(total, "task")} · ${Math.round(
              (completed / total) * 100,
            )}%`,
      progress: total === 0 ? null : { completed, total },
      action: { label: "Open", target: { view: "teams", runId: snapshot.run.id } },
      key: `run:${snapshot.run.id}`,
      at: sources.now,
    };
  },
};

export const activeAgentsWidget: IslandWidget = {
  id: "activeAgents",
  displayName: "Active agents",
  build(sources) {
    const working = sources.runs.flatMap((snapshot) =>
      snapshot.tasks
        .filter((task) => task.status === "running" || task.status === "claimed")
        .map((task) => ({ runId: snapshot.run.id, task })),
    );
    const busy = sources.busySessions;

    if (working.length === 0 && busy.length === 0) {
      return null;
    }

    const first = working[0];
    const title =
      working.length + busy.length === 1
        ? (first?.task.title ?? busy[0]?.name ?? "Working")
        : `${plural(working.length + busy.length, "agent")} active`;

    return {
      widget: "activeAgents",
      priority: ISLAND_PRIORITY.agentActivity,
      title,
      // A solo session has no task graph, so it gets its state, not a number.
      detail: first
        ? `${first.task.assignedTo ?? "unassigned"} · ${first.task.status}`
        : (busy[0]?.status ?? "working"),
      progress: null,
      action: first
        ? { label: "Open", target: { view: "teams", runId: first.runId } }
        : busy[0]?.target
          ? { label: "Open", target: busy[0].target }
          : busy[0]
            ? { label: "Open", target: { view: "chat", sessionId: busy[0].sessionId } }
            : null,
      key: first ? `task:${first.task.id}` : `session:${busy[0]?.sessionId ?? ""}`,
      at: sources.now,
    };
  },
};

export const providerUsageWidget: IslandWidget = {
  id: "providerUsage",
  displayName: "Provider usage",
  build(sources) {
    const reported = (sources.usage?.snapshots ?? []).filter(
      (snapshot) => snapshot.state === "available" && snapshot.limits.length > 0,
    );
    if (reported.length === 0) {
      return null;
    }

    // Only what the providers themselves reported (spec §55). A limit whose
    // numbers do not add up to a percentage is left out rather than guessed.
    const parts = reported.flatMap((snapshot) =>
      snapshot.limits
        .map((limit) => ({ limit, used: usedPercent(limit) }))
        .filter((entry): entry is { limit: UsageLimit; used: number } => entry.used !== null)
        .map((entry) => `${snapshot.providerId} ${entry.used}%`),
    );
    if (parts.length === 0) {
      return null;
    }

    return {
      widget: "providerUsage",
      priority: ISLAND_PRIORITY.providerUsage,
      title: parts.slice(0, 2).join("   "),
      detail: parts.length > 2 ? parts.slice(2).join("   ") : "",
      progress: null,
      action: { label: "Open", target: { view: "providers" } },
      key: "usage",
      at: sources.now,
    };
  },
};

export const idleWidget: IslandWidget = {
  id: "idle",
  displayName: "Idle",
  build(sources) {
    return {
      widget: "idle",
      priority: ISLAND_PRIORITY.idle,
      title: "AI Workbench · Idle",
      detail: "",
      progress: null,
      action: null,
      key: "idle",
      at: sources.now,
    };
  },
};

/** Built in, in the order a tie is broken. Plugins may add to this later. */
export const builtInWidgets: IslandWidget[] = [
  needsAttentionWidget,
  errorsWidget,
  connectionHealthWidget,
  completedWorkWidget,
  teamProgressWidget,
  activeAgentsWidget,
  providerUsageWidget,
  idleWidget,
];
