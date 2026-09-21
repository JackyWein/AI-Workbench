import type { TeamTask, TeamTaskStatus } from "@ai-workbench/shared";

/**
 * The task graph (spec §45).
 *
 * It is a pure function of the tasks it is given: which ones are runnable now,
 * which are waiting and on what, and whether the graph has stalled. The
 * orchestrator decides what to do about it; this only says what is true.
 */

const TERMINAL: ReadonlySet<TeamTaskStatus> = new Set([
  "completed",
  "failed",
  "cancelled",
]);

export function isTerminal(status: TeamTaskStatus): boolean {
  return TERMINAL.has(status);
}

/** Dependencies that are not yet completed, in declaration order. */
export function unmetDependencies(
  task: TeamTask,
  byId: ReadonlyMap<string, TeamTask>,
): string[] {
  return task.dependencies.filter((id) => byId.get(id)?.status !== "completed");
}

/** A dependency that failed or was cancelled can never be met. */
export function deadDependencies(
  task: TeamTask,
  byId: ReadonlyMap<string, TeamTask>,
): string[] {
  return task.dependencies.filter((id) => {
    const status = byId.get(id)?.status;
    return status === "failed" || status === "cancelled";
  });
}

export interface GraphView {
  readonly byId: ReadonlyMap<string, TeamTask>;
  /** Waiting tasks whose dependencies are all met, highest priority first. */
  readonly runnable: TeamTask[];
  /** Waiting tasks that still depend on something. */
  readonly blocked: TeamTask[];
  /** Tasks an agent has taken but not finished. */
  readonly inFlight: TeamTask[];
  /** Blocked tasks that can never become runnable. */
  readonly unsatisfiable: TeamTask[];
  readonly completed: TeamTask[];
  readonly failed: TeamTask[];
}

export function viewOf(tasks: readonly TeamTask[]): GraphView {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const runnable: TeamTask[] = [];
  const blocked: TeamTask[] = [];
  const inFlight: TeamTask[] = [];
  const unsatisfiable: TeamTask[] = [];
  const completed: TeamTask[] = [];
  const failed: TeamTask[] = [];

  for (const task of tasks) {
    switch (task.status) {
      case "completed":
        completed.push(task);
        continue;
      case "failed":
        failed.push(task);
        continue;
      case "cancelled":
        continue;
      case "claimed":
      case "running":
        inFlight.push(task);
        continue;
      default:
        break;
    }

    if (deadDependencies(task, byId).length > 0) {
      unsatisfiable.push(task);
      blocked.push(task);
      continue;
    }
    if (unmetDependencies(task, byId).length > 0) {
      blocked.push(task);
      continue;
    }
    runnable.push(task);
  }

  // Higher priority first, then oldest first, so a run is reproducible.
  runnable.sort(
    (left, right) =>
      right.priority - left.priority ||
      left.createdAt.getTime() - right.createdAt.getTime(),
  );

  return { byId, runnable, blocked, inFlight, unsatisfiable, completed, failed };
}

/** The status a waiting task should carry, given the rest of the graph. */
export function settledStatus(
  task: TeamTask,
  byId: ReadonlyMap<string, TeamTask>,
): TeamTaskStatus {
  if (isTerminal(task.status) || task.status === "claimed" || task.status === "running") {
    return task.status;
  }
  return unmetDependencies(task, byId).length > 0 ? "blocked" : "ready";
}

/**
 * A cycle makes a set of tasks permanently unrunnable, so it is detected when
 * the dependency is added rather than discovered as a stalled run.
 */
export function wouldCycle(
  taskId: string,
  dependencies: readonly string[],
  byId: ReadonlyMap<string, TeamTask>,
): boolean {
  const seen = new Set<string>();
  const stack = [...dependencies];
  while (stack.length > 0) {
    const current = stack.pop();
    if (current === undefined || seen.has(current)) {
      continue;
    }
    if (current === taskId) {
      return true;
    }
    seen.add(current);
    stack.push(...(byId.get(current)?.dependencies ?? []));
  }
  return false;
}

/** How deep a new child sits, which bounds runaway delegation (spec §51). */
export function depthOf(
  parentTaskId: string | null,
  byId: ReadonlyMap<string, TeamTask>,
): number {
  if (!parentTaskId) {
    return 0;
  }
  return (byId.get(parentTaskId)?.depth ?? 0) + 1;
}

/**
 * True when nothing can make progress any more: nothing runnable, nothing in
 * flight, and something still waiting. That is a stall, not a finished run,
 * and the difference matters for what the user is told.
 */
export function hasStalled(view: GraphView): boolean {
  return (
    view.runnable.length === 0 && view.inFlight.length === 0 && view.blocked.length > 0
  );
}
