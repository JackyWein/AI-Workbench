import { eq } from "drizzle-orm";
import type { Database } from "@ai-workbench/database";
import {
  teamArtifacts,
  teamDecisions,
  teamMessages,
  teamRuns,
  teamTasks,
  teamTurns,
  type TeamArtifactRow,
  type TeamDecisionRow,
  type TeamMessageRow,
  type TeamRunRow,
  type TeamTaskRow,
  type TeamTurnRow,
} from "@ai-workbench/database";
import type {
  MessageAttachment,
  SharedTeamState,
  TeamArtifact,
  TeamDecision,
  TeamMessage,
  TeamRun,
  TeamRunConfig,
  TeamRunSnapshot,
  TeamTask,
  TeamTurn,
} from "@ai-workbench/shared";
import {
  sharedTeamStateSchema,
  teamRunConfigSchema,
  teamRunStatusSchema,
  teamRunStopReasonSchema,
  teamTaskStatusSchema,
  teamMessageTypeSchema,
} from "@ai-workbench/shared";
import type { TeamRunStore } from "@ai-workbench/team";

/**
 * SQLite behind the team's run store (spec §53). Every write is a single row
 * upsert, so a run that is interrupted leaves a consistent graph rather than a
 * half-written batch.
 */
export class SqlTeamRunStore implements TeamRunStore {
  readonly #db: Database;

  constructor(db: Database) {
    this.#db = db;
  }

  async loadSnapshot(runId: string): Promise<TeamRunSnapshot | null> {
    const [row] = await this.#db
      .select()
      .from(teamRuns)
      .where(eq(teamRuns.id, runId))
      .limit(1);
    if (!row) {
      return null;
    }

    const [tasks, messages, decisions, artifacts, turns] = await Promise.all([
      this.#db.select().from(teamTasks).where(eq(teamTasks.runId, runId)),
      this.#db.select().from(teamMessages).where(eq(teamMessages.runId, runId)),
      this.#db.select().from(teamDecisions).where(eq(teamDecisions.runId, runId)),
      this.#db.select().from(teamArtifacts).where(eq(teamArtifacts.runId, runId)),
      this.#db.select().from(teamTurns).where(eq(teamTurns.runId, runId)),
    ]);

    return {
      run: toRun(row),
      tasks: tasks.map(toTask),
      messages: messages.map(toMessage),
      decisions: decisions.map(toDecision),
      artifacts: artifacts.map(toArtifact),
      turns: turns.map(toTurn).sort((a, b) => a.startedAt.getTime() - b.startedAt.getTime()),
    };
  }

  async saveRun(run: TeamRun): Promise<void> {
    const values = {
      id: run.id,
      teamId: run.teamId,
      workspaceId: run.workspaceId,
      sessionId: run.sessionId,
      goal: run.goal,
      status: run.status,
      stopReason: run.stopReason,
      outcome: run.outcome,
      sharedState: run.sharedState as unknown as Record<string, unknown>,
      limits: run.limits as unknown as Record<string, unknown>,
      agentCalls: run.agentCalls,
      failures: run.failures,
      messageCount: run.messageCount,
      createdAt: run.createdAt,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
    };
    await this.#db
      .insert(teamRuns)
      .values(values)
      .onConflictDoUpdate({ target: teamRuns.id, set: values });
  }

  async saveTask(task: TeamTask): Promise<void> {
    const values = {
      id: task.id,
      runId: task.runId,
      title: task.title,
      description: task.description,
      status: task.status,
      createdBy: task.createdBy,
      assignedTo: task.assignedTo,
      parentTaskId: task.parentTaskId,
      dependencies: task.dependencies,
      priority: task.priority,
      depth: task.depth,
      delegations: task.delegations,
      result: task.result,
      artifacts: task.artifacts,
      error: task.error,
      createdAt: task.createdAt,
      startedAt: task.startedAt,
      completedAt: task.completedAt,
    };
    await this.#db
      .insert(teamTasks)
      .values(values)
      .onConflictDoUpdate({ target: teamTasks.id, set: values });
  }

  async saveMessage(message: TeamMessage): Promise<void> {
    const values = {
      id: message.id,
      runId: message.runId,
      fromAgent: message.from,
      toAgent: message.to,
      type: message.type,
      content: message.content,
      taskId: message.taskId,
      attachments: message.attachments as unknown as unknown[],
      readAt: message.readAt,
      timestamp: message.timestamp,
    };
    await this.#db
      .insert(teamMessages)
      .values(values)
      .onConflictDoUpdate({ target: teamMessages.id, set: values });
  }

  async saveDecision(decision: TeamDecision): Promise<void> {
    const values = {
      id: decision.id,
      runId: decision.runId,
      author: decision.author,
      title: decision.title,
      reason: decision.reason,
      decision: decision.decision,
      relatedTasks: decision.relatedTasks,
      timestamp: decision.timestamp,
    };
    await this.#db
      .insert(teamDecisions)
      .values(values)
      .onConflictDoUpdate({ target: teamDecisions.id, set: values });
  }

  async saveArtifact(artifact: TeamArtifact): Promise<void> {
    const values = {
      id: artifact.id,
      runId: artifact.runId,
      name: artifact.name,
      type: artifact.type,
      path: artifact.path,
      content: artifact.content,
      createdBy: artifact.createdBy,
      taskId: artifact.taskId,
      metadata: artifact.metadata,
      timestamp: artifact.timestamp,
    };
    await this.#db
      .insert(teamArtifacts)
      .values(values)
      .onConflictDoUpdate({ target: teamArtifacts.id, set: values });
  }

  async saveTurn(turn: TeamTurn): Promise<void> {
    const values = {
      id: turn.id,
      runId: turn.runId,
      agentId: turn.agentId,
      taskId: turn.taskId,
      status: turn.status,
      output: turn.output,
      steps: turn.steps.map((step) => ({ at: step.at.getTime(), detail: step.detail })),
      error: turn.error,
      startedAt: turn.startedAt,
      finishedAt: turn.finishedAt,
    };
    await this.#db
      .insert(teamTurns)
      .values(values)
      .onConflictDoUpdate({ target: teamTurns.id, set: values });
  }
}

/**
 * A stored row is data from an earlier version of the application, so it is
 * validated on the way back in rather than trusted.
 */
export function toRun(row: TeamRunRow): TeamRun {
  return {
    id: row.id,
    teamId: row.teamId,
    workspaceId: row.workspaceId,
    sessionId: row.sessionId ?? null,
    goal: row.goal,
    status: teamRunStatusSchema.catch("failed").parse(row.status),
    stopReason: row.stopReason
      ? teamRunStopReasonSchema.catch("cancelled").parse(row.stopReason)
      : null,
    outcome: row.outcome,
    sharedState: sharedTeamStateSchema.parse(row.sharedState ?? {}) as SharedTeamState,
    limits: teamRunConfigSchema.parse(row.limits ?? {}) as TeamRunConfig,
    agentCalls: row.agentCalls,
    failures: row.failures,
    messageCount: row.messageCount,
    createdAt: row.createdAt,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
  };
}

export function toTask(row: TeamTaskRow): TeamTask {
  return {
    id: row.id,
    runId: row.runId,
    title: row.title,
    description: row.description,
    status: teamTaskStatusSchema.catch("failed").parse(row.status),
    createdBy: row.createdBy,
    assignedTo: row.assignedTo,
    parentTaskId: row.parentTaskId,
    dependencies: row.dependencies,
    priority: row.priority,
    depth: row.depth,
    delegations: row.delegations,
    result: row.result,
    artifacts: row.artifacts,
    error: row.error,
    createdAt: row.createdAt,
    startedAt: row.startedAt,
    completedAt: row.completedAt,
  };
}

export function toMessage(row: TeamMessageRow): TeamMessage {
  return {
    id: row.id,
    runId: row.runId,
    from: row.fromAgent,
    to: row.toAgent,
    type: teamMessageTypeSchema.catch("info").parse(row.type),
    content: row.content,
    taskId: row.taskId,
    attachments: (Array.isArray(row.attachments) ? row.attachments : []) as MessageAttachment[],
    readAt: row.readAt,
    timestamp: row.timestamp,
  };
}

export function toDecision(row: TeamDecisionRow): TeamDecision {
  return {
    id: row.id,
    runId: row.runId,
    author: row.author,
    title: row.title,
    reason: row.reason,
    decision: row.decision,
    relatedTasks: row.relatedTasks,
    timestamp: row.timestamp,
  };
}

export function toArtifact(row: TeamArtifactRow): TeamArtifact {
  return {
    id: row.id,
    runId: row.runId,
    name: row.name,
    type: row.type,
    path: row.path,
    content: row.content,
    createdBy: row.createdBy,
    taskId: row.taskId,
    metadata: row.metadata,
    timestamp: row.timestamp,
  };
}

export function toTurn(row: TeamTurnRow): TeamTurn {
  const steps = Array.isArray(row.steps) ? row.steps : [];
  return {
    id: row.id,
    runId: row.runId,
    agentId: row.agentId,
    taskId: row.taskId,
    // A turn that was running when the application stopped did not finish.
    status: row.status === "completed" ? "completed" : row.status === "running" && row.finishedAt === null ? "running" : "failed",
    output: row.output,
    steps: steps
      .filter((step) => typeof step?.detail === "string" && typeof step.at === "number")
      .map((step) => ({ at: new Date(step.at), detail: step.detail.slice(0, 300) })),
    error: row.error,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
  };
}
