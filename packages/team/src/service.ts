import type {
  AgentDefinition,
  Logger,
  SharedTeamState,
  TeamArtifact,
  TeamDecision,
  TeamDefinition,
  TeamEvent,
  TeamMessage,
  TeamMessageType,
  TeamRun,
  TeamRunSnapshot,
  TeamRunStopReason,
  TeamTask,
} from "@ai-workbench/shared";
import {
  newArtifactId,
  newDecisionId,
  newMessageId,
  newTaskId,
} from "./ids.js";
import {
  canCreateTask,
  canDelegate,
  canSendMessage,
  wouldPingPong,
  type LimitVerdict,
} from "./limits.js";
import { depthOf, isTerminal, settledStatus, viewOf, wouldCycle } from "./task-graph.js";
import type { TeamRunStore } from "./store.js";

/** Everyone on the team, for a broadcast message. */
export const EVERYONE = "*";

export class TeamLimitError extends Error {
  readonly limit: string;

  constructor(verdict: LimitVerdict) {
    super(verdict.reason ?? "A team limit was reached");
    this.name = "TeamLimitError";
    this.limit = String(verdict.limit ?? "unknown");
  }
}

export class TeamRuleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TeamRuleError";
  }
}

export interface TeamServiceOptions {
  readonly team: TeamDefinition;
  readonly snapshot: TeamRunSnapshot;
  readonly store: TeamRunStore;
  readonly logger: Logger;
  readonly emit: (event: TeamEvent) => void;
  readonly now?: () => Date;
}


/**
 * The shared workspace a team collaborates through (spec §43).
 *
 * It owns the task graph, the mailboxes, the shared state, the decisions and
 * the artifacts, and it is the only thing the Team MCP server talks to. It
 * makes no semantic judgements: it enforces the rules and the limits, and
 * records what agents decide.
 */
export class TeamService {
  readonly #team: TeamDefinition;
  readonly #store: TeamRunStore;
  readonly #logger: Logger;
  readonly #emit: (event: TeamEvent) => void;
  readonly #now: () => Date;

  #run: TeamRun;
  #tasks: TeamTask[];
  #messages: TeamMessage[];
  #decisions: TeamDecision[];
  #artifacts: TeamArtifact[];
  /** Which agents have held each task, for ping-pong protection (spec §51). */
  readonly #handlers = new Map<string, string[]>();

  constructor(options: TeamServiceOptions) {
    this.#team = options.team;
    this.#store = options.store;
    this.#logger = options.logger.child("TEAM");
    this.#emit = options.emit;
    this.#now = options.now ?? (() => new Date());

    this.#run = options.snapshot.run;
    this.#tasks = [...options.snapshot.tasks];
    this.#messages = [...options.snapshot.messages];
    this.#decisions = [...options.snapshot.decisions];
    this.#artifacts = [...options.snapshot.artifacts];

    // A restored run must not forget who already held a task.
    for (const task of this.#tasks) {
      if (task.assignedTo) {
        this.#handlers.set(task.id, [task.assignedTo]);
      }
    }
  }

  get team(): TeamDefinition {
    return this.#team;
  }

  get run(): TeamRun {
    return this.#run;
  }

  snapshot(): TeamRunSnapshot {
    return {
      run: this.#run,
      tasks: [...this.#tasks],
      messages: [...this.#messages],
      decisions: [...this.#decisions],
      artifacts: [...this.#artifacts],
    };
  }

  // --- what an agent may read ---------------------------------------------

  getGoal(): string {
    return this.#run.goal;
  }

  /** The bounded shared context, never a chat history (spec §47). */
  getState(): SharedTeamState & {
    tasks: string[];
    decisions: string[];
    artifacts: string[];
    agents: string[];
  } {
    return {
      ...this.#run.sharedState,
      tasks: this.#tasks.map((task) => `${task.id} [${task.status}] ${task.title}`),
      decisions: this.#decisions.map((entry) => `${entry.title}: ${entry.decision}`),
      artifacts: this.#artifacts.map((entry) => `${entry.id} (${entry.type}) ${entry.name}`),
      agents: this.#team.agents.map(
        (agent) => `${agent.id} ${agent.displayName}${agent.role ? ` — ${agent.role}` : ""}`,
      ),
    };
  }

  listAgents(): AgentDefinition[] {
    return [...this.#team.agents];
  }

  getAgent(agentId: string): AgentDefinition | null {
    return this.#team.agents.find((agent) => agent.id === agentId) ?? null;
  }

  listTasks(filter?: { status?: string; assignedTo?: string }): TeamTask[] {
    return this.#tasks.filter(
      (task) =>
        (!filter?.status || task.status === filter.status) &&
        (!filter?.assignedTo || task.assignedTo === filter.assignedTo),
    );
  }

  getTask(taskId: string): TeamTask | null {
    return this.#tasks.find((task) => task.id === taskId) ?? null;
  }

  // --- the task graph ------------------------------------------------------

  async createTask(input: {
    title: string;
    description?: string;
    createdBy: string;
    assignedTo?: string | null;
    parentTaskId?: string | null;
    dependencies?: string[];
    priority?: number;
  }): Promise<TeamTask> {
    const byId = new Map(this.#tasks.map((task) => [task.id, task]));
    const parentTaskId = input.parentTaskId ?? null;
    const depth = depthOf(parentTaskId, byId);

    const verdict = canCreateTask(this.#run, this.#tasks, depth);
    if (!verdict.allowed) {
      throw new TeamLimitError(verdict);
    }

    const dependencies = input.dependencies ?? [];
    for (const dependency of dependencies) {
      if (!byId.has(dependency)) {
        throw new TeamRuleError(`Task "${dependency}" does not exist`);
      }
    }

    const id = newTaskId();
    if (wouldCycle(id, dependencies, byId)) {
      throw new TeamRuleError("Those dependencies would create a cycle");
    }
    if (input.assignedTo && !this.getAgent(input.assignedTo)) {
      throw new TeamRuleError(`Agent "${input.assignedTo}" is not on this team`);
    }

    const now = this.#now();
    const task: TeamTask = {
      id,
      runId: this.#run.id,
      title: input.title,
      description: input.description ?? "",
      status: dependencies.length > 0 ? "blocked" : "ready",
      createdBy: input.createdBy,
      assignedTo: input.assignedTo ?? null,
      parentTaskId,
      dependencies,
      priority: input.priority ?? 0,
      depth,
      delegations: 0,
      result: null,
      artifacts: [],
      error: null,
      createdAt: now,
      startedAt: null,
      completedAt: null,
    };

    this.#tasks.push(task);
    await this.#store.saveTask(task);
    this.#emit({ type: "TASK_CREATED", runId: this.#run.id, task });
    if (task.assignedTo) {
      this.#emit({
        type: "TASK_ASSIGNED",
        runId: this.#run.id,
        taskId: task.id,
        agentId: task.assignedTo,
      });
    }
    if (task.status === "blocked") {
      this.#emit({
        type: "TASK_BLOCKED",
        runId: this.#run.id,
        taskId: task.id,
        waitingFor: dependencies,
      });
    }
    return task;
  }

  /** An agent takes a task it may work on. */
  async claimTask(taskId: string, agentId: string): Promise<TeamTask> {
    const task = this.#require(taskId);
    if (!this.getAgent(agentId)) {
      throw new TeamRuleError(`Agent "${agentId}" is not on this team`);
    }
    if (isTerminal(task.status)) {
      throw new TeamRuleError(`"${task.title}" is already ${task.status}`);
    }
    if (task.assignedTo && task.assignedTo !== agentId) {
      throw new TeamRuleError(`"${task.title}" belongs to ${task.assignedTo}`);
    }
    if (task.status === "blocked") {
      throw new TeamRuleError(`"${task.title}" is still waiting on other work`);
    }

    const updated = await this.#update(task, {
      status: "claimed",
      assignedTo: agentId,
    });
    this.#recordHandler(taskId, agentId);
    // Only a change of hands is news; a task created for this agent already
    // reported its assignment.
    if (task.assignedTo !== agentId) {
      this.#emit({ type: "TASK_ASSIGNED", runId: this.#run.id, taskId, agentId });
    }
    return updated;
  }

  /** Hands a task to another agent, bounded against ping-pong (spec §51). */
  async delegateTask(taskId: string, toAgentId: string, from: string): Promise<TeamTask> {
    const task = this.#require(taskId);
    if (!this.getAgent(toAgentId)) {
      throw new TeamRuleError(`Agent "${toAgentId}" is not on this team`);
    }
    if (isTerminal(task.status)) {
      throw new TeamRuleError(`"${task.title}" is already ${task.status}`);
    }

    const verdict = canDelegate(this.#run, task);
    if (!verdict.allowed) {
      throw new TeamLimitError(verdict);
    }
    const history = this.#handlers.get(taskId) ?? [];
    if (wouldPingPong(history, toAgentId)) {
      throw new TeamRuleError(
        `"${task.title}" has already been with ${toAgentId} twice; break it down or finish it`,
      );
    }

    const updated = await this.#update(task, {
      assignedTo: toAgentId,
      status: task.status === "blocked" ? "blocked" : "ready",
      delegations: task.delegations + 1,
    });
    this.#recordHandler(taskId, toAgentId);
    this.#logger.info("Task delegated", { taskId, from, to: toAgentId });
    this.#emit({ type: "TASK_ASSIGNED", runId: this.#run.id, taskId, agentId: toAgentId });
    return updated;
  }

  async startTask(taskId: string): Promise<TeamTask> {
    const task = this.#require(taskId);
    const updated = await this.#update(task, {
      status: "running",
      startedAt: task.startedAt ?? this.#now(),
    });
    this.#emit({ type: "TASK_STARTED", runId: this.#run.id, taskId });
    return updated;
  }

  async updateTask(
    taskId: string,
    patch: { description?: string; priority?: number; result?: string },
  ): Promise<TeamTask> {
    const task = this.#require(taskId);
    return this.#update(task, {
      ...(patch.description === undefined ? {} : { description: patch.description }),
      ...(patch.priority === undefined ? {} : { priority: patch.priority }),
      ...(patch.result === undefined ? {} : { result: patch.result }),
    });
  }

  async completeTask(
    taskId: string,
    result: string,
    artifacts: string[] = [],
  ): Promise<TeamTask> {
    const task = this.#require(taskId);
    if (isTerminal(task.status)) {
      throw new TeamRuleError(`"${task.title}" is already ${task.status}`);
    }
    const updated = await this.#update(task, {
      status: "completed",
      result,
      artifacts,
      completedAt: this.#now(),
    });
    this.#emit({ type: "TASK_COMPLETED", runId: this.#run.id, taskId, result });
    await this.#resettle();
    return updated;
  }

  async failTask(taskId: string, error: string): Promise<TeamTask> {
    const task = this.#require(taskId);
    if (isTerminal(task.status)) {
      return task;
    }
    const updated = await this.#update(task, {
      status: "failed",
      error,
      completedAt: this.#now(),
    });
    this.#run = { ...this.#run, failures: this.#run.failures + 1 };
    await this.#store.saveRun(this.#run);
    this.#emit({ type: "TASK_FAILED", runId: this.#run.id, taskId, error });
    await this.#resettle();
    return updated;
  }

  // --- mailbox -------------------------------------------------------------

  async sendMessage(input: {
    from: string;
    to: string;
    type: TeamMessageType;
    content: string;
    taskId?: string | null;
  }): Promise<TeamMessage> {
    const verdict = canSendMessage(this.#run);
    if (!verdict.allowed) {
      throw new TeamLimitError(verdict);
    }
    if (input.to !== EVERYONE && !this.getAgent(input.to)) {
      throw new TeamRuleError(`Agent "${input.to}" is not on this team`);
    }

    const message: TeamMessage = {
      id: newMessageId(),
      runId: this.#run.id,
      from: input.from,
      to: input.to,
      type: input.type,
      content: input.content,
      taskId: input.taskId ?? null,
      readAt: null,
      timestamp: this.#now(),
    };
    this.#messages.push(message);
    await this.#store.saveMessage(message);
    this.#run = { ...this.#run, messageCount: this.#run.messageCount + 1 };
    await this.#store.saveRun(this.#run);
    this.#emit({ type: "MESSAGE_SENT", runId: this.#run.id, message });
    return message;
  }

  /** An agent's inbox. Reading marks the messages read, so none arrives twice. */
  async getMessages(
    agentId: string,
    options: { unreadOnly?: boolean } = {},
  ): Promise<TeamMessage[]> {
    const inbox = this.#messages.filter(
      (message) =>
        (message.to === agentId || message.to === EVERYONE) &&
        message.from !== agentId &&
        (!options.unreadOnly || message.readAt === null),
    );

    const now = this.#now();
    for (const message of inbox) {
      if (message.readAt === null) {
        const read = { ...message, readAt: now };
        this.#messages = this.#messages.map((entry) =>
          entry.id === message.id ? read : entry,
        );
        await this.#store.saveMessage(read);
      }
    }
    return inbox.map((message) => ({ ...message, readAt: message.readAt ?? now }));
  }

  /** An agent that cannot continue asks, rather than guessing (spec §50). */
  async requestHelp(input: {
    from: string;
    question: string;
    taskId?: string | null;
  }): Promise<TeamMessage> {
    const message = await this.sendMessage({
      from: input.from,
      to: this.#team.leadAgentId ?? EVERYONE,
      type: "question",
      content: input.question,
      ...(input.taskId === undefined ? {} : { taskId: input.taskId }),
    });
    this.#emit({
      type: "HELP_REQUESTED",
      runId: this.#run.id,
      agentId: input.from,
      taskId: input.taskId ?? null,
      question: input.question,
    });
    this.emitAttentionRequired(`Help requested by ${input.from}: ${input.question}`);
    return message;
  }

  // --- decisions and artifacts --------------------------------------------

  async recordDecision(input: {
    author: string;
    title: string;
    reason?: string;
    decision: string;
    relatedTasks?: string[];
  }): Promise<TeamDecision> {
    const decision: TeamDecision = {
      id: newDecisionId(),
      runId: this.#run.id,
      author: input.author,
      title: input.title,
      reason: input.reason ?? "",
      decision: input.decision,
      relatedTasks: input.relatedTasks ?? [],
      timestamp: this.#now(),
    };
    this.#decisions.push(decision);
    await this.#store.saveDecision(decision);
    this.#emit({ type: "DECISION_RECORDED", runId: this.#run.id, decision });
    return decision;
  }

  getDecisions(): TeamDecision[] {
    return [...this.#decisions];
  }

  async publishArtifact(input: {
    name: string;
    type: string;
    createdBy: string;
    path?: string | null;
    content?: string | null;
    taskId?: string | null;
    metadata?: Record<string, unknown>;
  }): Promise<TeamArtifact> {
    const artifact: TeamArtifact = {
      id: newArtifactId(),
      runId: this.#run.id,
      name: input.name,
      type: input.type,
      path: input.path ?? null,
      content: input.content ?? null,
      createdBy: input.createdBy,
      taskId: input.taskId ?? null,
      metadata: input.metadata ?? {},
      timestamp: this.#now(),
    };
    this.#artifacts.push(artifact);
    await this.#store.saveArtifact(artifact);
    this.#emit({ type: "ARTIFACT_PUBLISHED", runId: this.#run.id, artifact });
    return artifact;
  }

  getArtifact(artifactId: string): TeamArtifact | null {
    return this.#artifacts.find((artifact) => artifact.id === artifactId) ?? null;
  }

  listArtifacts(): TeamArtifact[] {
    return [...this.#artifacts];
  }

  // --- shared state and the run itself ------------------------------------

  async updateSharedState(patch: Partial<SharedTeamState>): Promise<SharedTeamState> {
    const sharedState: SharedTeamState = {
      ...this.#run.sharedState,
      ...(patch.goal === undefined ? {} : { goal: patch.goal }),
      ...(patch.summary === undefined ? {} : { summary: patch.summary }),
      ...(patch.currentPlan === undefined ? {} : { currentPlan: patch.currentPlan }),
      ...(patch.importantContext === undefined
        ? {}
        : { importantContext: patch.importantContext }),
    };
    this.#run = { ...this.#run, sharedState };
    await this.#store.saveRun(this.#run);
    return sharedState;
  }

  /** The lead declares the goal reached (spec §52). */
  async finishGoal(outcome: string, author: string): Promise<TeamRun> {
    this.#logger.info("Goal declared finished", { runId: this.#run.id, author });
    return this.stop("completed", "goalFinished", outcome);
  }

  async start(): Promise<TeamRun> {
    this.#run = {
      ...this.#run,
      status: "running",
      startedAt: this.#run.startedAt ?? this.#now(),
    };
    await this.#store.saveRun(this.#run);
    this.#emit({ type: "TEAM_STARTED", runId: this.#run.id, goal: this.#run.goal });
    return this.#run;
  }

  async stop(
    status: TeamRun["status"],
    stopReason: TeamRunStopReason,
    outcome: string | null = null,
  ): Promise<TeamRun> {
    this.#run = {
      ...this.#run,
      status,
      stopReason,
      outcome,
      finishedAt: status === "paused" ? null : this.#now(),
    };
    await this.#store.saveRun(this.#run);
    this.#emit({
      type: "TEAM_FINISHED",
      runId: this.#run.id,
      status,
      stopReason,
      outcome,
    });
    return this.#run;
  }

  /** Agent lifecycle, reported by the orchestrator that owns it (spec §50). */
  emitAgentStarted(agentId: string): void {
    this.#emit({ type: "AGENT_STARTED", runId: this.#run.id, agentId });
  }

  emitAgentStopped(agentId: string): void {
    this.#emit({ type: "AGENT_STOPPED", runId: this.#run.id, agentId });
  }

  emitAgentFailed(agentId: string, error: string): void {
    this.#emit({ type: "AGENT_FAILED", runId: this.#run.id, agentId, error });
  }

  /** Something a person has to look at before the run can go on (spec §50). */
  emitAttentionRequired(reason: string): void {
    this.#emit({ type: "USER_ATTENTION_REQUIRED", runId: this.#run.id, reason });
  }

  /** The orchestrator counts every provider call against the run's budget. */
  async countAgentCall(): Promise<TeamRun> {
    this.#run = { ...this.#run, agentCalls: this.#run.agentCalls + 1 };
    await this.#store.saveRun(this.#run);
    return this.#run;
  }

  view(): ReturnType<typeof viewOf> {
    return viewOf(this.#tasks);
  }

  // --- internals -----------------------------------------------------------

  #require(taskId: string): TeamTask {
    const task = this.getTask(taskId);
    if (!task) {
      throw new TeamRuleError(`Task "${taskId}" does not exist`);
    }
    return task;
  }

  #recordHandler(taskId: string, agentId: string): void {
    const history = this.#handlers.get(taskId) ?? [];
    this.#handlers.set(taskId, [...history, agentId]);
  }

  async #update(task: TeamTask, patch: Partial<TeamTask>): Promise<TeamTask> {
    const updated: TeamTask = { ...task, ...patch };
    this.#tasks = this.#tasks.map((entry) => (entry.id === task.id ? updated : entry));
    await this.#store.saveTask(updated);
    return updated;
  }

  /** Completing a task can unblock others; the graph decides, not the caller. */
  async #resettle(): Promise<void> {
    const byId = new Map(this.#tasks.map((task) => [task.id, task]));
    for (const task of [...this.#tasks]) {
      const status = settledStatus(task, byId);
      if (status !== task.status) {
        await this.#update(task, { status });
        if (status === "ready") {
          this.#logger.debug("Task unblocked", { taskId: task.id });
        }
      }
    }
  }
}
