import {
  ISLAND_PRIORITY,
  type AggregatedUsage,
  type IslandAgentRow,
  type IslandOption,
  type IslandUsageRow,
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
  /**
   * The members of those runs' teams, by agent id: the name the team gave
   * each and the mark of the tool it runs on. An id alone means nothing to
   * a person; without an entry the id is all there is.
   */
  readonly members?: ReadonlyArray<{ agentId: string; name: string; icon: string | null }>;
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
    /** When this work really began; absent when nobody knows. */
    startedAt?: Date | null;
    /** The provider's mark, when the work belongs to one. */
    icon?: string | null;
    /** What the work reported so far (tokens, context), in one line. */
    detail?: string;
    /** Stable identity across refreshes; defaults to `session:<sessionId>`. */
    key?: string;
  }>;
  /**
   * The providers worth a usage row, in display order, with their names and
   * marks. Empty means "name rows by provider id", which is all a bare
   * snapshot knows.
   */
  readonly providers: ReadonlyArray<{ id: string; name: string; icon: string | null }>;
  /** Every session the user has, busy or not, with when it last did anything. */
  readonly sessions: ReadonlyArray<{
    name: string;
    icon: string | null;
    lastActiveAt: Date;
    busy: boolean;
  }>;
  /** Things waiting on a person, newest first (spec §99). */
  readonly attention: ReadonlyArray<{
    key: string;
    title: string;
    detail: string;
    runId?: string;
    sessionId?: string;
    /** Where "Open" lands when it is neither a run nor a chat. */
    target?: IslandTarget;
    /** The mark of the tool that is waiting, when one is. */
    icon?: string | null;
    /**
     * Answers the island can give in place, e.g. Allow and Deny. Empty when
     * the only way to answer is where "Open" leads.
     */
    options?: readonly IslandOption[];
    at: Date;
  }>;
  /** Questions an agent put to the person, with its choices, newest first. */
  readonly questions: ReadonlyArray<{
    key: string;
    /** The question itself. */
    title: string;
    detail: string;
    /** The mark of the tool that asks. */
    icon?: string | null;
    /** Choices the island can answer with in place; empty when it cannot. */
    options: readonly IslandOption[];
    target: IslandTarget;
    at: Date;
  }>;
  /** Failures worth surfacing, newest first. */
  readonly errors: ReadonlyArray<{
    key: string;
    title: string;
    detail: string;
    sessionId?: string;
    runId?: string;
    /** The mark of the tool whose work failed, when one did. */
    icon?: string | null;
    at: Date;
  }>;
  /** Connections the application knows are down. */
  readonly brokenConnections: ReadonlyArray<{ key: string; title: string; detail: string }>;
  /**
   * A downloaded update of the app waiting for a restart, until the person
   * answers it; null when there is none or they chose "Later".
   */
  readonly update: {
    key: string;
    title: string;
    detail: string;
    at: Date;
  } | null;
  /** Work that finished recently, newest first. */
  readonly completed: ReadonlyArray<{
    key: string;
    title: string;
    detail: string;
    runId?: string;
    /** Where "Open" lands for work that is not a team run. */
    target?: IslandTarget;
    /** The mark of the tool whose work finished. */
    icon?: string | null;
    at: Date;
  }>;
  readonly now: Date;
}

export interface IslandWidget {
  readonly id: IslandWidgetId;
  readonly displayName: string;
  /**
   * The widget preference that switches this one on and off, when it has no
   * toggle of its own; defaults to its own id.
   */
  readonly toggle?: IslandWidgetId;
  /** At most one entry, or null when this widget has nothing to report. */
  build(sources: IslandSources): IslandEntry | null;
}

function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}

/**
 * New entry fields default to quiet: no options, no diff, no mark override,
 * no usage rows. Builders spread this so the schema can grow without every
 * widget naming every field.
 */
function quietDefaults(): Pick<IslandEntry, "options" | "usage" | "icon" | "diff" | "agents"> {
  return { options: [], usage: [], icon: null, diff: null, agents: [] };
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
      ...quietDefaults(),
      icon: first.icon ?? null,
      options: [...(first.options ?? [])],
      priority: ISLAND_PRIORITY.userActionRequired,
      title: first.title,
      detail:
        sources.attention.length > 1
          ? `${first.detail} · ${sources.attention.length - 1} more waiting`
          : first.detail,
      progress: null,
      action: {
        label: "Open",
        target:
          first.target ??
          (first.runId
            ? { view: "teams", runId: first.runId }
            : first.sessionId
              ? { view: "chat", sessionId: first.sessionId }
              : { view: "chat" }),
      },
      key: first.key,
      at: first.at,
    };
  },
};

/**
 * A question an agent is waiting on, with its choices. It belongs to the
 * "Needs attention" preference: a question is one more way an agent waits on
 * a person, not a separate thing to switch on.
 */
export const agentQuestionWidget: IslandWidget = {
  id: "agentQuestion",
  displayName: "Agent question",
  toggle: "needsAttention",
  build(sources) {
    const first = sources.questions[0];
    if (!first) {
      return null;
    }
    return {
      widget: "agentQuestion",
      ...quietDefaults(),
      icon: first.icon ?? null,
      options: first.options.slice(0, 9),
      priority: ISLAND_PRIORITY.agentQuestion,
      title: first.title,
      detail:
        sources.questions.length > 1
          ? [first.detail, `${sources.questions.length - 1} more waiting`].filter(Boolean).join(" · ")
          : first.detail,
      progress: null,
      action: { label: "Answer", target: first.target },
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
      ...quietDefaults(),
      icon: first.icon ?? null,
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
      ...quietDefaults(),
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
      ...quietDefaults(),
      priority: ISLAND_PRIORITY.workCompleted,
      title: first.title,
      detail: first.detail,
      ...(first.icon ? { icon: first.icon } : {}),
      progress: null,
      action: first.target
        ? { label: "Open", target: first.target }
        : first.runId
          ? { label: "Open", target: { view: "teams", runId: first.runId } }
          : null,
      key: first.key,
      at: first.at,
    };
  },
};

/** A member by its team's name for it, and its tool's mark. */
function memberOf(sources: IslandSources, agentId: string): { name: string; icon: string | null } {
  const member = sources.members?.find((entry) => entry.agentId === agentId);
  return { name: member?.name ?? agentId, icon: member?.icon ?? null };
}

/**
 * What a member is doing right now, from its running turn: the task it works
 * on and the last step its tool reported — never the run's opening goal.
 */
function nowDoing(snapshot: TeamRunSnapshot, turn: TeamRunSnapshot["turns"][number]): string {
  const task = turn.taskId ? snapshot.tasks.find((entry) => entry.id === turn.taskId) : undefined;
  const step = turn.steps[turn.steps.length - 1]?.detail;
  return [task?.title ?? "Planning the next steps", step].filter(Boolean).join(" · ");
}

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
    const turn = snapshot.turns.find((entry) => entry.status === "running");

    return {
      widget: "teamProgress",
      ...quietDefaults(),
      priority: ISLAND_PRIORITY.activeProgress,
      // What is happening now: who works on what. The goal only until a
      // member has started.
      title: turn
        ? `${memberOf(sources, turn.agentId).name}: ${nowDoing(snapshot, turn)}`.slice(0, 200)
        : snapshot.run.goal,
      ...(turn ? { icon: memberOf(sources, turn.agentId).icon } : {}),
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
      // Every member at work is a row of its own, with what it is doing
      // now; a running team with nobody mid-turn is one row with its goal
      // and its counted tasks.
      agents: running
        .flatMap((entry): IslandAgentRow[] => {
          const turns = entry.turns.filter((item) => item.status === "running");
          if (turns.length > 0) {
            return turns.map((item) => {
              const member = memberOf(sources, item.agentId);
              return {
                key: `turn:${item.id}`,
                title: member.name.slice(0, 120),
                detail: nowDoing(entry, item).slice(0, 160),
                icon: member.icon,
                startedAt: item.startedAt,
                target: { view: "teams", runId: entry.run.id },
              };
            });
          }
          const tasks = entry.tasks;
          const done = tasks.filter((task) => task.status === "completed").length;
          const blocked = tasks.filter((task) => task.status === "blocked").length;
          return [
            {
              key: `run:${entry.run.id}`,
              title: entry.run.goal.slice(0, 120),
              detail: (tasks.length === 0
                ? "Planning"
                : `${done}/${plural(tasks.length, "task")}${blocked > 0 ? ` · ${blocked} blocked` : ""}`
              ).slice(0, 160),
              icon: null,
              startedAt: entry.run.startedAt,
              target: { view: "teams", runId: entry.run.id },
            },
          ];
        })
        .slice(0, 24),
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
        ? (first
            ? `${memberOf(sources, first.task.assignedTo ?? "").name}: ${first.task.title}`
            : (busy[0]?.name ?? "Working"))
        : `${plural(working.length + busy.length, "agent")} active`;

    // One row per session or terminal agent, so the island can list them
    // rather than a count. Team tasks appear as their team's row instead.
    const agents: IslandAgentRow[] = [
      ...busy.map((session): IslandAgentRow => ({
        key: session.key ?? `session:${session.sessionId}`,
        title: session.name.slice(0, 120),
        detail: (session.detail ?? session.status).slice(0, 160),
        icon: session.icon ?? null,
        startedAt: session.startedAt ?? null,
        target: session.target ?? { view: "chat", sessionId: session.sessionId },
      })),
    ].slice(0, 24);
    const lead = agents[0];

    return {
      widget: "activeAgents",
      ...quietDefaults(),
      agents,
      icon: lead?.icon ?? null,
      priority: ISLAND_PRIORITY.agentActivity,
      title,
      // A solo session has no task graph, so it gets its state, not a number.
      detail: first
        ? `${first.task.assignedTo ? memberOf(sources, first.task.assignedTo).name : "unassigned"} · ${first.task.status}`
        : (lead?.detail ?? "working"),
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
    const snapshots = sources.usage?.snapshots ?? [];
    const known = sources.providers.length > 0
      ? sources.providers
      : snapshots.map((snapshot) => ({
          id: snapshot.providerId,
          name: snapshot.providerId,
          icon: null,
        }));

    // Only what the providers themselves reported (spec §55). A limit whose
    // numbers do not add up to a percentage is left out rather than guessed,
    // and a provider without one says so instead of showing a bar.
    const rows: IslandUsageRow[] = known.flatMap((provider): IslandUsageRow[] => {
      const snapshot = snapshots.find((entry) => entry.providerId === provider.id);
      const measured =
        snapshot && snapshot.state !== "unavailable"
          ? snapshot.limits.flatMap((limit): IslandUsageRow[] => {
              const used = usedPercent(limit);
              return used === null
                ? []
                : [
                    {
                      providerId: provider.id,
                      name: provider.name,
                      icon: provider.icon,
                      window: limit.label,
                      percentLeft: Math.min(100, Math.max(0, 100 - used)),
                      ...(limit.forecast ? { forecast: limit.forecast } : {}),
                      note: "",
                    },
                  ];
            })
          : [];
      if (measured.length > 0) {
        return measured;
      }
      return [
        {
          providerId: provider.id,
          name: provider.name,
          icon: provider.icon,
          window: "",
          percentLeft: null,
          note:
            snapshot && snapshot.state !== "unavailable"
              ? "No limit reported"
              : "Usage unavailable",
        },
      ];
    });
    const numbered = rows.filter((row) => row.percentLeft !== null);
    if (numbered.length === 0) {
      return null;
    }
    const parts = numbered.map((row) => `${row.name} ${100 - (row.percentLeft ?? 0)}%`);

    return {
      widget: "providerUsage",
      ...quietDefaults(),
      priority: ISLAND_PRIORITY.providerUsage,
      title: parts.slice(0, 2).join("   "),
      detail: parts.length > 2 ? parts.slice(2).join("   ") : "",
      progress: null,
      action: { label: "Open", target: { view: "providers" } },
      key: "usage",
      at: sources.now,
      usage: rows.slice(0, 24),
    };
  },
};

/**
 * The app's own update, downloaded and waiting for a restart: "Later" or
 * "Restart now", answered on the island. It belongs to the "Needs attention"
 * preference — it is one more thing that waits on the person — and yields to
 * an agent that waits on them.
 */
export const appUpdateWidget: IslandWidget = {
  id: "appUpdate",
  displayName: "Update ready",
  toggle: "needsAttention",
  build(sources) {
    const update = sources.update;
    if (!update) {
      return null;
    }
    return {
      widget: "appUpdate",
      ...quietDefaults(),
      options: [
        { id: "later", label: "Later" },
        { id: "restart", label: "Restart now" },
      ],
      priority: ISLAND_PRIORITY.updateReady,
      title: update.title,
      detail: update.detail,
      progress: null,
      action: { label: "Settings", target: { view: "settings" } },
      key: update.key,
      at: update.at,
    };
  },
};

export const idleWidget: IslandWidget = {
  id: "idle",
  displayName: "Idle",
  build(sources) {
    return {
      widget: "idle",
      ...quietDefaults(),
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
  agentQuestionWidget,
  errorsWidget,
  connectionHealthWidget,
  appUpdateWidget,
  completedWorkWidget,
  teamProgressWidget,
  activeAgentsWidget,
  providerUsageWidget,
  idleWidget,
];
