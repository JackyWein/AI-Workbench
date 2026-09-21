import type { TeamRun, TeamRunConfig, TeamTask } from "@ai-workbench/shared";

/**
 * Loop protection and autonomy limits (spec §51).
 *
 * Every refusal names the limit it hit, because an agent that is told "no"
 * without a reason will simply try again.
 */

export interface LimitVerdict {
  readonly allowed: boolean;
  readonly limit?: keyof TeamRunConfig | "runtime";
  readonly reason?: string;
}

const ALLOWED: LimitVerdict = { allowed: true };

function refuse(limit: LimitVerdict["limit"], reason: string): LimitVerdict {
  return { allowed: false, ...(limit ? { limit } : {}), reason };
}

/** Whether the run may still spend a provider call. */
export function canCallAgent(run: TeamRun, now: Date): LimitVerdict {
  if (run.agentCalls >= run.limits.maxAgentCalls) {
    return refuse(
      "maxAgentCalls",
      `The run has used its ${run.limits.maxAgentCalls} agent calls`,
    );
  }
  if (run.failures >= run.limits.maxFailures) {
    return refuse("maxFailures", `The run reached ${run.limits.maxFailures} failures`);
  }
  const started = run.startedAt ?? run.createdAt;
  const minutes = (now.getTime() - started.getTime()) / 60_000;
  if (minutes >= run.limits.maxRuntimeMinutes) {
    return refuse("runtime", `The run reached its ${run.limits.maxRuntimeMinutes} minutes`);
  }
  return ALLOWED;
}

export function canCreateTask(
  run: TeamRun,
  tasks: readonly TeamTask[],
  depth: number,
): LimitVerdict {
  if (tasks.length >= run.limits.maxTasks) {
    return refuse("maxTasks", `The run already has ${run.limits.maxTasks} tasks`);
  }
  if (depth > run.limits.maxTaskDepth) {
    return refuse(
      "maxTaskDepth",
      `Tasks may not be nested deeper than ${run.limits.maxTaskDepth}`,
    );
  }
  return ALLOWED;
}

export function canSendMessage(run: TeamRun): LimitVerdict {
  if (run.messageCount >= run.limits.maxMessages) {
    return refuse("maxMessages", `The run has sent its ${run.limits.maxMessages} messages`);
  }
  return ALLOWED;
}

export function canDelegate(run: TeamRun, task: TeamTask): LimitVerdict {
  if (task.delegations >= run.limits.maxDelegationsPerTask) {
    return refuse(
      "maxDelegationsPerTask",
      `"${task.title}" has already been handed on ${run.limits.maxDelegationsPerTask} times`,
    );
  }
  return ALLOWED;
}

/**
 * Ping-pong protection: two agents handing the same task back and forth make
 * progress look busy while nothing moves. A task that returns to an agent it
 * already had, beyond a small allowance, is refused (spec §51).
 */
export function wouldPingPong(
  history: readonly string[],
  nextAgentId: string,
  allowance = 2,
): boolean {
  const seen = history.filter((agentId) => agentId === nextAgentId).length;
  return seen >= allowance;
}
