import type {
  AIProviderAdapter,
  ProviderSessionHandle,
} from "@ai-workbench/provider-base";
import type {
  AgentDefinition,
  Logger,
  TeamRun,
  TeamTask,
} from "@ai-workbench/shared";
import { canCallAgent } from "./limits.js";
import { buildAgentPrompt } from "./prompt.js";
import { parseTeamActions, type TeamAction } from "./protocol.js";
import { TeamLimitError, TeamRuleError, type TeamService } from "./service.js";
import { hasStalled } from "./task-graph.js";

/** What the orchestrator needs from the provider layer, and nothing more. */
export interface AgentRuntime {
  /** Resolves the adapter for an agent, or null if its provider is missing. */
  adapterFor(agent: AgentDefinition): AIProviderAdapter | null;
}

export interface TeamOrchestratorOptions {
  readonly service: TeamService;
  readonly runtime: AgentRuntime;
  readonly logger: Logger;
  /**
   * Overrides the run's `agentTurnSilenceSeconds`. Tests use it; production
   * reads the run's own limit so a team can be given a different budget than
   * the 10-minute default.
   */
  readonly turnTimeoutMs?: number;
}

/** How often a working turn says so while it works. */
const PROGRESS_MS = 5_000;

interface AgentSession {
  readonly adapter: AIProviderAdapter;
  readonly handle: ProviderSessionHandle;
}

/**
 * The deterministic runtime behind a team (spec §44).
 *
 * It is not a model. It schedules ready tasks onto agents, enforces the run's
 * limits, applies whatever actions an agent returns, persists as it goes and
 * stops for a reason it can name. Every semantic decision — what the work is,
 * who should do it, whether it is done — belongs to the agents.
 */
export class TeamOrchestrator {
  readonly #service: TeamService;
  readonly #runtime: AgentRuntime;
  readonly #logger: Logger;
  readonly #sessions = new Map<string, AgentSession>();
  readonly #turnTimeoutMs: number | undefined;

  #stopping = false;
  #stopReason: "paused" | "cancelled" = "paused";
  #running: Promise<TeamRun> | null = null;

  constructor(options: TeamOrchestratorOptions) {
    this.#service = options.service;
    this.#runtime = options.runtime;
    this.#logger = options.logger.child("TEAM");
    this.#turnTimeoutMs = options.turnTimeoutMs;
  }

  /**
   * How long one turn may go silent before it is cut off. The run's own
   * setting wins over the 10-minute default; an explicit override (tests)
   * wins over both. This is the silence budget, not the work budget: a turn
   * that keeps producing resets it.
   */
  get #silenceMs(): number {
    if (this.#turnTimeoutMs !== undefined) {
      return this.#turnTimeoutMs;
    }
    const seconds = this.#service.run.limits.agentTurnSilenceSeconds;
    return (Number.isFinite(seconds) && seconds > 0 ? seconds : 600) * 1000;
  }

  /** Runs until the goal is finished, nothing is left, or a limit is hit. */
  async run(): Promise<TeamRun> {
    if (this.#running) {
      return this.#running;
    }
    this.#stopping = false;
    this.#stopReason = "paused";
    this.#running = this.#loop().finally(() => {
      this.#running = null;
    });
    return this.#running;
  }

  /** Asks the run to stop after the turns in flight; never kills mid-answer. */
  async pause(): Promise<TeamRun> {
    this.#stopping = true;
    this.#stopReason = "paused";
    await this.#running?.catch(() => undefined);
    return this.#service.run.status === "running"
      ? this.#service.stop("paused", "paused")
      : this.#service.run;
  }

  /**
   * Cancels immediately: in-flight provider turns are cancelled at once,
   * then the run is awaited with a grace race so Stop never hangs on a
   * 120s turn timeout. Teardown failures never mask the stop itself.
   */
  async cancel(reason: "cancelled" | "paused" = "cancelled"): Promise<TeamRun> {
    this.#stopping = true;
    this.#stopReason = reason;
    await Promise.allSettled(
      [...this.#sessions].map(async ([agentId, session]) => {
        try {
          await session.adapter.cancel(session.handle);
        } catch (error) {
          this.#logger.warn("Agent turn cancel failed", {
            agentId,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }),
    );
    if (this.#running) {
      await Promise.race([
        this.#running.catch(() => undefined),
        new Promise((resolve) => setTimeout(resolve, 5000)),
      ]);
    }
    // The loop may have stopped as paused just before cancel won the race;
    // a cancel request always ends cancelled, never paused.
    if (reason === "cancelled" && this.#service.run.status !== "cancelled") {
      const status = this.#service.run.status;
      if (status === "running" || status === "paused") {
        return this.#service.stop("cancelled", "cancelled");
      }
    }
    if (this.#service.run.status === "running") {
      return reason === "paused"
        ? this.#service.stop("paused", "paused")
        : this.#service.stop("cancelled", "cancelled");
    }
    return this.#service.run;
  }

  async dispose(): Promise<void> {
    this.#stopping = true;
    // Never hang teardown on a turn that ignores cancellation: 5s grace,
    // then sessions are destroyed anyway.
    if (this.#running) {
      await Promise.race([
        this.#running.catch(() => undefined),
        new Promise((resolve) => setTimeout(resolve, 5000)),
      ]);
    }
    for (const [agentId, session] of this.#sessions) {
      try {
        await session.adapter.destroySession?.(session.handle);
      } catch (error) {
        this.#logger.warn("Agent session cleanup failed", {
          agentId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      this.#emitStopped(agentId);
    }
    this.#sessions.clear();
  }

  async #loop(): Promise<TeamRun> {
    if (this.#service.run.status !== "running") {
      await this.#service.start();
    }

    for (;;) {
      if (this.#stopping) {
        return this.#stopReason === "cancelled"
          ? this.#service.stop("cancelled", "cancelled")
          : this.#service.stop("paused", "paused");
      }

      const verdict = canCallAgent(this.#service.run, new Date());
      if (!verdict.allowed) {
        this.#logger.warn("Run stopped by a limit", { reason: verdict.reason });
        return this.#service.stop(
          verdict.limit === "maxFailures" ? "failed" : "completed",
          verdict.limit === "maxFailures" ? "tooManyFailures" : "limitReached",
        );
      }

      const view = this.#service.view();

      // Work that is ready runs first; independent tasks run together, up to
      // the run's concurrency limit (spec §45, §51). The batch never spends
      // more agent calls than the run has left, so maxAgentCalls cannot be
      // overshot by a wide batch.
      const capacity = this.#service.run.limits.maxConcurrentAgents - view.inFlight.length;
      const remainingCalls = this.#service.run.limits.maxAgentCalls - this.#service.run.agentCalls;
      if (remainingCalls <= 0) {
        this.#logger.warn("Run stopped by a limit", { reason: "no agent calls left" });
        return this.#service.stop("completed", "limitReached");
      }
      const batch = view.runnable.slice(0, Math.max(0, Math.min(capacity, remainingCalls)));

      if (batch.length > 0) {
        await Promise.all(batch.map((task) => this.#workOn(task)));
        continue;
      }

      if (view.inFlight.length > 0) {
        // Concurrency is saturated by turns claimed outside this loop (e.g.
        // via Team MCP). Wait for progress instead of spinning hot.
        await new Promise((resolve) => setTimeout(resolve, 100));
        continue;
      }

      if (hasStalled(view)) {
        const stuck = view.unsatisfiable[0] ?? view.blocked[0];
        this.#logger.warn("Task graph stalled", { taskId: stuck?.id });
        await this.#service.sendMessage({
          from: "orchestrator",
          to: this.#leadId() ?? "*",
          type: "warning",
          content:
            `Nothing can run: "${stuck?.title ?? "a task"}" is waiting on work that ` +
            "will not complete. Re-plan or finish the goal.",
          ...(stuck ? { taskId: stuck.id } : {}),
        });
        this.#service.emitAttentionRequired(
          `Task graph stalled on "${stuck?.title ?? "a task"}"`,
        );
      }

      // Nothing runnable: the lead decides what happens next.
      const lead = this.#lead();
      if (!lead) {
        return this.#service.stop("failed", "noWorkLeft");
      }

      const before = this.#service.run;
      await this.#turn(lead, null);
      const after = this.#service.run;

      if (after.status !== "running") {
        return after;
      }
      // The lead was given a turn and created nothing: the run is over rather
      // than looping on an agent with nothing to say.
      if (
        this.#service.view().runnable.length === 0 &&
        this.#service.view().inFlight.length === 0 &&
        after.agentCalls > before.agentCalls
      ) {
        return this.#service.stop("completed", "noWorkLeft");
      }
    }
  }

  async #workOn(task: TeamTask): Promise<void> {
    const agent = this.#agentFor(task);
    if (!agent) {
      await this.#service.failTask(
        task.id,
        "No agent on this team can take this task",
      );
      return;
    }

    try {
      await this.#service.claimTask(task.id, agent.id);
      await this.#service.startTask(task.id);
    } catch (error) {
      this.#logger.warn("Task could not be started", {
        taskId: task.id,
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    }

    await this.#turn(agent, task);

    // An agent that answered without finishing its task must not leave it
    // hanging: a task nobody closed is a failure, and says so.
    const current = this.#service.getTask(task.id);
    if (current && (current.status === "running" || current.status === "claimed")) {
      await this.#service.failTask(
        task.id,
        `${agent.displayName} answered without completing or failing the task`,
      );
    }
  }

  async #turn(agent: AgentDefinition, task: TeamTask | null): Promise<void> {
    const inbox = await this.#service.getMessages(agent.id, { unreadOnly: true });
    const prompt = buildAgentPrompt({
      service: this.#service,
      agent,
      isLead: agent.id === this.#leadId(),
      task,
      inbox,
    });

    let answer: string;
    try {
      answer = await this.#ask(agent, prompt);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.#logger.error("Agent turn failed", { agentId: agent.id, error: message });
      this.#service.emitAgentFailed(agent.id, message);
      // A failed turn must be visible in the run, not silent: without this
      // the Messages tab stays empty and the run just ends with noWorkLeft.
      try {
        await this.#service.sendMessage({
          from: agent.id,
          to: "*",
          type: "warning",
          content: `${agent.displayName} turn failed: ${message}`,
          ...(task ? { taskId: task.id } : {}),
        });
      } catch {
        // Mailbox limits must not mask the original turn failure.
      }
      if (task) {
        await this.#service.failTask(task.id, `${agent.displayName}: ${message}`);
      }
      return;
    }

    const { actions, rejected } = parseTeamActions(answer);
    for (const entry of rejected) {
      this.#logger.warn("Agent produced an unusable action", {
        agentId: agent.id,
        reason: entry.reason,
      });
    }

    for (const action of actions) {
      await this.#apply(agent, action, task);
      if (this.#service.run.status !== "running") {
        return;
      }
    }

    if (actions.length === 0 && rejected.length > 0) {
      await this.#service.sendMessage({
        from: "orchestrator",
        to: agent.id,
        type: "warning",
        content:
          "None of your action blocks could be read. Use one JSON object per " +
          "```team block, with an \"action\" field.",
      });
    }
  }

  async #apply(
    agent: AgentDefinition,
    action: TeamAction,
    current: TeamTask | null,
  ): Promise<void> {
    try {
      switch (action.action) {
        case "create_task":
          await this.#service.createTask({
            title: action.title,
            ...(action.description === undefined ? {} : { description: action.description }),
            createdBy: agent.id,
            ...(action.assignTo === undefined ? {} : { assignedTo: action.assignTo }),
            ...(current ? { parentTaskId: current.id } : {}),
            ...(action.dependsOn === undefined ? {} : { dependencies: action.dependsOn }),
            ...(action.priority === undefined ? {} : { priority: action.priority }),
          });
          return;
        case "delegate_task":
          await this.#service.delegateTask(action.taskId, action.to, agent.id);
          return;
        case "complete_task":
          await this.#service.completeTask(
            action.taskId,
            action.result,
            action.artifacts ?? [],
          );
          return;
        case "fail_task":
          await this.#service.failTask(action.taskId, action.error);
          return;
        case "send_message":
          await this.#service.sendMessage({
            from: agent.id,
            to: action.to,
            type: action.type,
            content: action.content,
            ...(action.taskId === undefined ? {} : { taskId: action.taskId }),
          });
          return;
        case "request_help":
          await this.#service.requestHelp({
            from: agent.id,
            question: action.question,
            ...(action.taskId === undefined ? {} : { taskId: action.taskId }),
          });
          return;
        case "publish_artifact":
          await this.#service.publishArtifact({
            name: action.name,
            type: action.type,
            createdBy: agent.id,
            ...(action.path === undefined ? {} : { path: action.path }),
            ...(action.content === undefined ? {} : { content: action.content }),
            ...(action.taskId === undefined ? {} : { taskId: action.taskId }),
          });
          return;
        case "record_decision":
          await this.#service.recordDecision({
            author: agent.id,
            title: action.title,
            ...(action.reason === undefined ? {} : { reason: action.reason }),
            decision: action.decision,
            ...(action.relatedTasks === undefined
              ? {}
              : { relatedTasks: action.relatedTasks }),
          });
          return;
        case "update_state":
          await this.#service.updateSharedState({
            ...(action.summary === undefined ? {} : { summary: action.summary }),
            ...(action.currentPlan === undefined ? {} : { currentPlan: action.currentPlan }),
            ...(action.importantContext === undefined
              ? {}
              : { importantContext: action.importantContext }),
          });
          return;
        case "finish_goal":
          if (this.#leadId() && agent.id !== this.#leadId()) {
            throw new TeamRuleError("Only the lead agent finishes the goal");
          }
          await this.#service.finishGoal(action.outcome, agent.id);
          return;
      }
    } catch (error) {
      if (error instanceof TeamLimitError || error instanceof TeamRuleError) {
        // A refusal is told to the agent that caused it, so the next turn can
        // do something different instead of repeating itself (spec §51).
        this.#logger.info("Team action refused", {
          agentId: agent.id,
          action: action.action,
          reason: error.message,
        });
        await this.#service
          .sendMessage({
            from: "orchestrator",
            to: agent.id,
            type: "warning",
            content: `Your ${action.action} was refused: ${error.message}`,
          })
          .catch(() => undefined);
        return;
      }
      throw error;
    }
  }

  /**
   * One provider call, counted against the run's budget and bounded in time.
   *
   * The bound is a *silence* budget: any text, tool call or status from the
   * provider pushes it back, so a slow model keeps its turn for as long as it
   * keeps doing something. A hard cap (the run's own runtime limit, or 10×
   * the silence budget) stops a provider that trickles one event per minute
   * from holding the run forever.
   */
  async #ask(agent: AgentDefinition, prompt: string): Promise<string> {
    const session = await this.#sessionFor(agent);
    await this.#service.countAgentCall();

    const collected: string[] = [];
    const stream = session.adapter.sendMessage(session.handle, { text: prompt });
    const silenceMs = this.#silenceMs;
    const hardCapMs = Math.max(
      silenceMs,
      Math.min(
        this.#service.run.limits.maxRuntimeMinutes * 60_000,
        silenceMs * 10,
      ),
    );

    let timer: ReturnType<typeof setTimeout> | null = null;
    let cap: ReturnType<typeof setTimeout> | null = null;
    let progressTimer: ReturnType<typeof setInterval> | null = null;
    let lastDetail = "";
    let lastSent = { detail: "", at: 0 };
    let rejectDeadline: ((error: Error) => void) | null = null;

    // What the agent is doing, said when it changes and otherwise at most
    // once a second: a streaming answer produces text many times a second,
    // and each event crosses to the window.
    const progress = (detail: string): void => {
      lastDetail = detail.length > 200 ? `${detail.slice(0, 199)}…` : detail;
      const now = Date.now();
      if (lastDetail === lastSent.detail && now - lastSent.at < 1_000) {
        return;
      }
      lastSent = { detail: lastDetail, at: now };
      this.#service.emitAgentProgress(agent.id, lastDetail);
    };

    const restartSilence = (): void => {
      if (timer) {
        clearTimeout(timer);
      }
      timer = setTimeout(() => {
        rejectDeadline?.(
          new Error(
            `no answer for ${Math.round(silenceMs / 1000)}s — the agent went quiet`,
          ),
        );
      }, silenceMs);
      timer.unref?.();
    };

    const deadline = new Promise<never>((_resolve, reject) => {
      rejectDeadline = reject;
      restartSilence();
      // The absolute cap is not slid: it ends the turn no matter what.
      cap = setTimeout(() => {
        reject(
          new Error(
            `turn exceeded ${Math.round(hardCapMs / 60_000)} minutes and was stopped`,
          ),
        );
      }, hardCapMs);
      cap.unref?.();
    });

    const consume = (async (): Promise<string> => {
      for await (const event of stream) {
        // Anything the tool says is proof of life, so the silence budget
        // starts over — the run's own runtime cap still bounds the total.
        restartSilence();
        if (event.type === "text_delta") {
          collected.push(event.text);
          progress("writing");
        } else if (event.type === "message") {
          // A provider that answers in one piece rather than streaming.
          collected.push(event.text);
          progress("writing");
        } else if (event.type === "tool_call") {
          progress(event.toolCall.summary ?? event.toolCall.name);
        } else if (event.type === "tool_result") {
          progress(`${event.toolCall.summary ?? event.toolCall.name} — ${event.toolCall.state}`);
        } else if (event.type === "status") {
          progress(event.status);
        } else if (event.type === "error") {
          throw new Error(event.error.message);
        }
      }
      return collected.join("");
    })();

    // A turn that streams for minutes without a status change still says so,
    // so the island and the run view show work rather than silence.
    progressTimer = setInterval(() => {
      this.#service.emitAgentProgress(agent.id, lastDetail || "working");
    }, PROGRESS_MS);
    progressTimer.unref?.();

    try {
      return await Promise.race([consume, deadline]);
    } catch (error) {
      // A timed-out turn must not keep the provider stream alive behind the
      // run: cancel the session so the call is released.
      void consume.catch(() => undefined);
      try {
        await session.adapter.cancel(session.handle);
      } catch {
        // Cancellation itself failing must not mask the original timeout.
      }
      throw error;
    } finally {
      if (timer) {
        clearTimeout(timer);
      }
      if (progressTimer) {
        clearInterval(progressTimer);
      }
      if (cap) {
        clearTimeout(cap);
      }
    }
  }

  async #sessionFor(agent: AgentDefinition): Promise<AgentSession> {
    const existing = this.#sessions.get(agent.id);
    if (existing) {
      return existing;
    }

    const adapter = this.#runtime.adapterFor(agent);
    if (!adapter) {
      throw new Error(`Provider "${agent.providerId}" is not available`);
    }

    const info = await adapter.createSession({
      sessionId: `${this.#service.run.id}:${agent.id}`,
      workingDirectory: agent.workingDirectory,
      ...(agent.modelId ? { modelId: agent.modelId } : {}),
    });
    const session: AgentSession = {
      adapter,
      handle: {
        providerSessionId: info.providerSessionId,
        sessionId: `${this.#service.run.id}:${agent.id}`,
        ...(info.modelId ? { modelId: info.modelId } : {}),
      },
    };
    this.#sessions.set(agent.id, session);
    this.#service.emitAgentStarted(agent.id);
    return session;
  }

  #emitStopped(agentId: string): void {
    this.#service.emitAgentStopped(agentId);
  }

  #leadId(): string | null {
    return this.#service.team.leadAgentId;
  }

  #lead(): AgentDefinition | null {
    const id = this.#leadId();
    return id ? this.#service.getAgent(id) : (this.#service.listAgents()[0] ?? null);
  }

  /** The assignee if there is one, else the lead, else the only agent. */
  #agentFor(task: TeamTask): AgentDefinition | null {
    if (task.assignedTo) {
      return this.#service.getAgent(task.assignedTo);
    }
    return this.#lead();
  }
}
