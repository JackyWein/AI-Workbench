import { asc, desc, eq, inArray } from "drizzle-orm";
import { join, relative, resolve, sep } from "node:path";
import type { Database } from "@ai-workbench/database";
import { teamAgents, teamRuns, teams, workspaces, type TeamAgentRow, type TeamRow } from "@ai-workbench/database";
import type {
  AgentDefinition,
  AuthStatus,
  CreateTeamInputData,
  InstallationStatus,
  Logger,
  McpServerConfig,
  MessageAttachment,
  ModelInfo,
  ProviderCapabilities,
  ProviderEvent,
  ProviderMetadata,
  ProviderUsageSnapshot,
  TeamDecision,
  TeamDefinition,
  TeamEvent,
  TeamMessage,
  TeamRun,
  TeamRunSnapshot,
  TeamSettings,
  UpdateTeamInputData,
} from "@ai-workbench/shared";
import {
  agentDefinitionSchema,
  createTeamInputSchema,
  teamSettingsSchema,
  upgradeRunLimits,
  updateTeamInputSchema,
} from "@ai-workbench/shared";
import {
  describeTeamMcpServer,
  TEAM_MCP_SERVER_ID,
  TeamOrchestrator,
  TeamService,
  newAgentId,
  newDecisionId,
  newMessageId,
  newRunId,
  newTeamId,
  type AgentRuntime,
  type TeamMcpScope,
  type TeamMcpStdio,
} from "@ai-workbench/team";
import type {
  AgentMessage,
  AIProviderAdapter,
  AuthRequest,
  AuthResult,
  InteractiveLaunch,
  InteractiveLaunchRequest,
  ProviderContext,
  ProviderImportables,
  ProviderSessionConfig,
  ProviderSessionHandle,
  ProviderSessionInfo,
  ProviderToolAccess,
} from "@ai-workbench/provider-base";
import type { EventBus } from "./event-bus.js";
import type { McpService } from "./mcp-service.js";
import type { ProviderManager } from "./provider-manager.js";
import { ToolBridge } from "./tool-bridge.js";
import { SqlTeamRunStore, toRun } from "./team-store.js";
import { inspectAttachments, keepAttachments } from "./attachments.js";
import { createId } from "./ids.js";
import { withServerGuidance, type ServerInstructionsLookup } from "./server-guidance.js";

export class TeamNotFoundError extends Error {
  constructor(id: string) {
    super(`Team "${id}" does not exist`);
    this.name = "TeamNotFoundError";
  }
}

export class TeamRunNotFoundError extends Error {
  constructor(id: string) {
    super(`Team run "${id}" does not exist`);
    this.name = "TeamRunNotFoundError";
  }
}

/** A team was pointed at a folder outside its workspace without permission. */
export class TeamOutsideWorkspaceError extends Error {
  constructor(
    readonly target: string,
    readonly workspacePath: string,
  ) {
    super(
      `"${target}" is outside this team's workspace (${workspacePath}). ` +
        "Turn on \"work outside the workspace\" to allow it.",
    );
    this.name = "TeamOutsideWorkspaceError";
  }
}

/** A team cannot change while one of its runs is going. */
export class TeamBusyError extends Error {
  constructor(readonly teamId: string) {
    super("This team has a run going. Pause or stop it before changing the team.");
    this.name = "TeamBusyError";
  }
}

/** A run cannot work in a workspace that is not on this computer. */
export class TeamWorkspaceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TeamWorkspaceError";
  }
}

/** Whether `target` is the folder itself or somewhere beneath it. */
function isInside(root: string, target: string): boolean {
  const from = resolve(root);
  const to = resolve(target);
  if (from === to) {
    return true;
  }
  const rel = relative(from, to);
  return rel.length > 0 && !rel.startsWith("..") && !rel.startsWith(`..${sep}`);
}

export interface TeamManagerOptions {
  readonly db: Database;
  readonly events: EventBus;
  readonly logger: Logger;
  readonly providers: ProviderManager;
  /** Present when team agents may use servers selected for them (spec §38). */
  readonly mcp?: McpService;
  /**
   * Where each run keeps copies of the files sent in it, mirroring solo
   * sessions. Without one, files go to the tool from where picked.
   */
  readonly attachmentsDirectory?: string;
  /**
   * Keeps a note of every goal a team finishes — what it was, what came out,
   * what was decided — in the shared long-term memory, so the next session or
   * team starts from it instead of from nothing. Without one, nothing is kept.
   */
  readonly recordMemory?: (note: { readonly title: string; readonly content: string }) => Promise<void>;
  /**
   * How a provider spawns its scoped team MCP server. Without it no team
   * server is handed out: there is no default, because the stdio bridge
   * serving a live run does not exist yet — the scope in the server's
   * environment already names the run and agent it will serve.
   */
  readonly teamMcp?: TeamMcpStdio;
}

interface ActiveRun {
  readonly service: TeamService;
  readonly orchestrator: TeamOrchestrator;
  readonly finished: Promise<TeamRun>;
}

/**
 * Teams, their runs and the orchestrators driving them (spec §44).
 *
 * The application owns the lifecycle here; the deterministic runtime lives in
 * `@ai-workbench/team` and knows nothing about the database or the UI.
 */
export class TeamManager {
  readonly #db: Database;
  readonly #events: EventBus;
  readonly #logger: Logger;
  readonly #providers: ProviderManager;
  readonly #store: SqlTeamRunStore;
  readonly #mcp: McpService | undefined;
  readonly #teamMcp: TeamMcpStdio | undefined;
  readonly #attachmentsDirectory: string | undefined;
  readonly #recordMemory: TeamManagerOptions["recordMemory"];
  readonly #toolBridge = new ToolBridge();
  readonly #active = new Map<string, ActiveRun>();

  constructor(options: TeamManagerOptions) {
    this.#db = options.db;
    this.#events = options.events;
    this.#logger = options.logger.child("TEAM");
    this.#providers = options.providers;
    this.#store = new SqlTeamRunStore(options.db);
    this.#mcp = options.mcp;
    this.#teamMcp = options.teamMcp;
    this.#attachmentsDirectory = options.attachmentsDirectory;
    this.#recordMemory = options.recordMemory;
  }

  // --- teams ---------------------------------------------------------------

  async list(workspaceId?: string): Promise<TeamDefinition[]> {
    const rows = workspaceId
      ? await this.#db.select().from(teams).where(eq(teams.workspaceId, workspaceId))
      : await this.#db.select().from(teams);
    return Promise.all(rows.map((row) => this.#withAgents(row)));
  }

  async get(teamId: string): Promise<TeamDefinition | null> {
    const [row] = await this.#db.select().from(teams).where(eq(teams.id, teamId)).limit(1);
    return row ? this.#withAgents(row) : null;
  }

  async require(teamId: string): Promise<TeamDefinition> {
    const team = await this.get(teamId);
    if (!team) {
      throw new TeamNotFoundError(teamId);
    }
    return team;
  }

  async create(
    raw: CreateTeamInputData & { workingDirectory: string },
  ): Promise<TeamDefinition> {
    // Parsed here as well as at the IPC boundary, so a caller inside the main
    // process cannot skip the defaults and the validation.
    const input = createTeamInputSchema.parse(raw);
    const now = new Date();
    const id = newTeamId();
    const settings = teamSettingsSchema.parse(input.settings ?? {});

    const agents: AgentDefinition[] = input.agents.map((agent) =>
      agentDefinitionSchema.parse({
        ...agent,
        id: newAgentId(),
        workingDirectory: agent.workingDirectory ?? raw.workingDirectory,
      }),
    );
    const leadIndex = input.leadAgentIndex ?? 0;

    await this.#db.insert(teams).values({
      id,
      workspaceId: input.workspaceId,
      name: input.name,
      leadAgentId: agents[leadIndex]?.id ?? null,
      settings: settings as unknown as Record<string, unknown>,
      createdAt: now,
      updatedAt: now,
    });
    for (const [position, agent] of agents.entries()) {
      await this.#db.insert(teamAgents).values({ ...toAgentRow(agent, id), position });
    }

    this.#logger.info("Team created", { teamId: id, agents: agents.length });
    return {
      id,
      name: input.name,
      workspaceId: input.workspaceId,
      leadAgentId: agents[leadIndex]?.id ?? null,
      agents,
      settings,
      createdAt: now,
      updatedAt: now,
    };
  }

  /** The lead is selectable at any time (spec §52). */
  async setLeadAgent(teamId: string, agentId: string | null): Promise<TeamDefinition> {
    const team = await this.require(teamId);
    if (agentId && !team.agents.some((agent) => agent.id === agentId)) {
      throw new Error(`Agent "${agentId}" is not on this team`);
    }
    await this.#db
      .update(teams)
      .set({ leadAgentId: agentId, updatedAt: new Date() })
      .where(eq(teams.id, teamId));
    return this.require(teamId);
  }

  /**
   * Points the team at a folder, or back at its workspace with null.
   *
   * A folder outside the workspace is refused unless the person turned
   * `allowOutsideWorkspace` on: a team never wanders off on its own, and when
   * it may, that was a decision someone made. Every agent follows the team
   * folder, so "where does this team work" has one honest answer.
   */
  async setWorkingDirectory(
    teamId: string,
    workingDirectory: string | null,
    allowOutsideWorkspace?: boolean,
  ): Promise<TeamDefinition> {
    const team = await this.require(teamId);
    const workspace = await this.#db
      .select()
      .from(workspaces)
      .where(eq(workspaces.id, team.workspaceId))
      .limit(1);
    const workspacePath = workspace[0]?.path;
    if (!workspacePath) {
      throw new TeamNotFoundError(team.workspaceId);
    }
    const allowOutside =
      allowOutsideWorkspace ?? team.settings.allowOutsideWorkspace;
    const target = workingDirectory === null ? null : resolve(workingDirectory);

    if (target && !isInside(workspacePath, target) && !allowOutside) {
      throw new TeamOutsideWorkspaceError(target, workspacePath);
    }

    const settings: TeamSettings = {
      ...team.settings,
      allowOutsideWorkspace: allowOutside,
      workingDirectory: target,
    };
    await this.#db
      .update(teams)
      .set({ settings: settings as unknown as Record<string, unknown>, updatedAt: new Date() })
      .where(eq(teams.id, teamId));

    if (target) {
      // The folder is the team's, so every member works there — a per-agent
      // override would only make "where does this team work" unanswerable.
      for (const agent of team.agents) {
        await this.#db
          .update(teamAgents)
          .set({ workingDirectory: target })
          .where(eq(teamAgents.id, agent.id));
      }
    }
    return this.require(teamId);
  }

  /**
   * Renames the team, changes who is on it and what each member runs on, and
   * picks the lead. A member that keeps its id keeps its place in earlier
   * runs; one left out leaves the team.
   *
   * While a run is going only safe changes are allowed: adding members,
   * renaming, instructions and lead. Removing a member or moving an existing
   * one to another provider/model is refused — the run may be waiting on that
   * agent or already hold its provider session. Additions are pushed into the
   * live run so the session shows them without a reload.
   */
  async update(raw: UpdateTeamInputData): Promise<TeamDefinition> {
    const input = updateTeamInputSchema.parse(raw);
    const team = await this.require(input.teamId);
    const actives = [...this.#active.values()].filter(
      (active) => active.service.run.teamId === team.id && active.service.run.status === "running",
    );
    if (actives.length > 0 && input.agents) {
      const inputIds = new Set(
        input.agents.map((agent) => agent.id).filter((id): id is string => Boolean(id)),
      );
      const removed = team.agents.filter((agent) => !inputIds.has(agent.id));
      if (removed.length > 0) {
        throw new TeamBusyError(team.id);
      }
      const current = new Map(team.agents.map((agent) => [agent.id, agent]));
      for (const agent of input.agents) {
        if (!agent.id) {
          continue;
        }
        const existing = current.get(agent.id);
        if (!existing) {
          continue;
        }
        // The run already holds this agent's provider session; switching its
        // tool mid-run would strand in-flight work.
        if (
          (agent.providerId !== undefined && agent.providerId !== existing.providerId) ||
          (agent.modelId !== undefined && (agent.modelId ?? undefined) !== (existing.modelId ?? undefined))
        ) {
          throw new TeamBusyError(team.id);
        }
      }
    } else if (actives.length > 0 && !input.agents) {
      // Name/instructions/lead only: safe, falls through.
    }

    let agentIds = team.agents.map((agent) => agent.id);
    if (input.agents) {
      const current = new Map(team.agents.map((agent) => [agent.id, agent]));
      // The folder column predates runs choosing their own; it is kept filled
      // for the rows' sake and never decides where a run works.
      const legacyFolder = team.agents[0]?.workingDirectory ?? (await this.#workspacePath(team.workspaceId));
      const next: AgentDefinition[] = input.agents.map((agent) => {
        const existing = agent.id ? current.get(agent.id) : undefined;
        return agentDefinitionSchema.parse({
          ...agent,
          id: existing?.id ?? newAgentId(),
          workingDirectory: existing?.workingDirectory ?? legacyFolder,
        });
      });
      const kept = new Set(next.map((agent) => agent.id));
      for (const agent of team.agents) {
        if (!kept.has(agent.id)) {
          await this.#db.delete(teamAgents).where(eq(teamAgents.id, agent.id));
        }
      }
      for (const [position, agent] of next.entries()) {
        const row = { ...toAgentRow(agent, team.id), position };
        if (current.has(agent.id)) {
          await this.#db.update(teamAgents).set(row).where(eq(teamAgents.id, agent.id));
        } else {
          await this.#db.insert(teamAgents).values(row);
        }
      }
      agentIds = next.map((agent) => agent.id);
    }

    const leadAgentId =
      input.leadAgentIndex !== undefined
        ? (agentIds[input.leadAgentIndex] ?? agentIds[0] ?? null)
        : team.leadAgentId && agentIds.includes(team.leadAgentId)
          ? team.leadAgentId
          : (agentIds[0] ?? null);
    const settings: TeamSettings = {
      ...team.settings,
      ...(input.instructions === undefined ? {} : { instructions: input.instructions }),
    };
    await this.#db
      .update(teams)
      .set({
        ...(input.name === undefined ? {} : { name: input.name }),
        leadAgentId,
        settings: settings as unknown as Record<string, unknown>,
        updatedAt: new Date(),
      })
      .where(eq(teams.id, team.id));
    this.#logger.info("Team updated", { teamId: team.id, agents: agentIds.length });
    const updated = await this.require(team.id);
    // A run that is going keeps its tasks and turns but sees the new roster
    // at once: every member works in the run's own folder, whatever the rows
    // once said, so the folder override is re-applied here.
    for (const active of actives) {
      const folder =
        active.service.team.agents[0]?.workingDirectory ??
        updated.agents[0]?.workingDirectory ??
        "";
      active.service.setTeam({
        ...updated,
        agents: updated.agents.map((agent) => ({ ...agent, workingDirectory: folder })),
      });
    }
    return updated;
  }

  async delete(teamId: string): Promise<boolean> {
    for (const [runId, active] of this.#active) {
      if (active.service.run.teamId === teamId) {
        await active.orchestrator.dispose();
        this.#active.delete(runId);
      }
    }
    await this.#db.delete(teams).where(eq(teams.id, teamId));
    return true;
  }

  // --- runs ----------------------------------------------------------------

  async listRuns(teamId?: string): Promise<TeamRun[]> {
    const rows = teamId
      ? await this.#db
          .select()
          .from(teamRuns)
          .where(eq(teamRuns.teamId, teamId))
          .orderBy(desc(teamRuns.createdAt))
      : await this.#db.select().from(teamRuns).orderBy(desc(teamRuns.createdAt));
    return rows.map(toRun);
  }

  async getSnapshot(runId: string): Promise<TeamRunSnapshot> {
    const active = this.#active.get(runId);
    if (active) {
      return active.service.snapshot();
    }
    const snapshot = await this.#store.loadSnapshot(runId);
    if (!snapshot) {
      throw new TeamRunNotFoundError(runId);
    }
    return snapshot;
  }

  /** Creates a run and starts it. The promise resolves when the run ends. */
  async startRun(input: {
    teamId: string;
    goal: string;
    workspaceId?: string;
    /** The session starting the run; it alone shows and continues it. */
    sessionId?: string;
    attachments?: readonly Pick<MessageAttachment, "path">[];
  }): Promise<TeamRun> {
    const team = await this.require(input.teamId);
    if (team.agents.length === 0) {
      throw new Error("A team needs at least one agent before it can run");
    }
    // Teams are not tied to a folder: a run works where it is started from.
    const workspaceId = input.workspaceId ?? team.workspaceId;
    const folder = await this.#runFolder(team, workspaceId);

    const now = new Date();
    const run: TeamRun = {
      id: newRunId(),
      teamId: team.id,
      workspaceId,
      sessionId: input.sessionId ?? null,
      goal: input.goal,
      status: "pending",
      stopReason: null,
      outcome: null,
      sharedState: {
        goal: input.goal,
        summary: "",
        currentPlan: null,
        importantContext: [],
      },
      limits: upgradeRunLimits(team.settings.limits),
      agentCalls: 0,
      failures: 0,
      messageCount: 0,
      createdAt: now,
      startedAt: null,
      finishedAt: null,
    };
    // Files starting the run travel as the first mail. It is written before
    // the run is driven, so the lead's very first turn already reads it —
    // sent afterwards, the copy of the files raced that turn and lost.
    const messages: TeamMessage[] = [];
    const starting = input.attachments ?? [];
    let kept: MessageAttachment[] = [];
    if (starting.length > 0) {
      try {
        kept = await this.#keepTeamAttachments(run.id, starting);
      } catch (error) {
        this.#logger.warn("Run goal files could not be kept", {
          runId: run.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    if (kept.length > 0) {
      run.messageCount = 1;
    }
    await this.#store.saveRun(run);
    if (kept.length > 0) {
      const request: TeamMessage = {
        id: newMessageId(),
        runId: run.id,
        from: "user",
        to: team.leadAgentId ?? "*",
        type: "request",
        content: input.goal,
        taskId: null,
        attachments: kept,
        readAt: null,
        timestamp: now,
      };
      await this.#store.saveMessage(request);
      messages.push(request);
    }

    this.#drive(team, folder, {
      run,
      tasks: [],
      messages,
      decisions: [],
      artifacts: [],
      turns: [],
    });
    return run;
  }

  /**
   * Gives a finished run its next goal without clearing the chat.
   *
   * A new goal used to mean a brand-new run, so the session's timeline was
   * swapped for an empty one: the old tasks, messages and turns vanished from
   * the view, and the agents lost their context too. Continuing reopens the
   * same run instead — the previous outcome is kept as a decision, the new
   * goal arrives as the next user message, and everything stays in the one
   * timeline the lead reads on its next turn. The spend counters restart for
   * the new segment (they are budgets for work, not history); the finished
   * tasks and turns stay as the record the team works from.
   */
  async continueRun(input: {
    runId: string;
    goal: string;
    /** The session continuing it; a run is only ever continued by its own. */
    sessionId?: string;
    attachments?: readonly Pick<MessageAttachment, "path">[];
  }): Promise<TeamRun> {
    if (this.#active.has(input.runId)) {
      throw new Error("This run is still going; send the team a note instead of a new goal.");
    }
    const snapshot = await this.#store.loadSnapshot(input.runId);
    if (!snapshot) {
      throw new TeamRunNotFoundError(input.runId);
    }
    const status = snapshot.run.status;
    if (status === "running" || status === "pending") {
      throw new Error("This run is still going; send the team a note instead of a new goal.");
    }
    if (status === "paused") {
      throw new Error("This run is paused; resume it instead of starting a new goal.");
    }
    // Continuing hands over the run's whole history and its members' provider
    // sessions, so another session's run is never continued: that session's
    // context would leak into this one. A run from before runs knew their
    // session is claimed by the first session that continues it.
    if (input.sessionId && snapshot.run.sessionId && snapshot.run.sessionId !== input.sessionId) {
      throw new Error("This run belongs to another session; start a new goal here instead.");
    }
    const goal = input.goal.trim();
    if (!goal) {
      throw new Error("A goal needs words before the team can continue.");
    }
    const team = await this.require(snapshot.run.teamId);
    const now = new Date();

    // The new goal message is written with the reopened run, before the
    // orchestrator is driving again, so the lead's first turn already reads
    // it — the same way a run started with files carries its goal as mail.
    const kept = await this.#keepTeamAttachments(snapshot.run.id, input.attachments ?? []);
    const continued: TeamRun = {
      ...snapshot.run,
      sessionId: snapshot.run.sessionId ?? input.sessionId ?? null,
      goal,
      status: "pending",
      stopReason: null,
      outcome: null,
      sharedState: { ...snapshot.run.sharedState, goal },
      agentCalls: 0,
      failures: 0,
      // The new goal's own request below is the one message counted.
      messageCount: 1,
      finishedAt: null,
    };
    await this.#store.saveRun(continued);

    const additions: TeamRunSnapshot = {
      ...snapshot,
      run: continued,
      messages: [...snapshot.messages],
      decisions: [...snapshot.decisions],
    };
    if (snapshot.run.outcome) {
      const finished: TeamDecision = {
        id: newDecisionId(),
        runId: continued.id,
        author: team.leadAgentId ?? team.agents[0]?.id ?? "user",
        title: `Finished: ${snapshot.run.goal.slice(0, 120)}`,
        reason: "",
        decision: snapshot.run.outcome,
        relatedTasks: [],
        timestamp: now,
      };
      additions.decisions.push(finished);
      await this.#store.saveDecision(finished);
    }
    const request: TeamMessage = {
      id: newMessageId(),
      runId: continued.id,
      from: "user",
      to: team.leadAgentId ?? "*",
      type: "request",
      content: goal,
      taskId: null,
      attachments: kept,
      readAt: null,
      timestamp: now,
    };
    additions.messages.push(request);
    await this.#store.saveMessage(request);

    this.#drive(team, await this.#runFolder(team, continued.workspaceId), additions);
    return continued;
  }

  /**
   * Runs the application was driving when it stopped — a crash, a kill, a
   * restart during development — are still marked as going in the database,
   * with nothing behind them: the screen says "Working", a note is refused as
   * "not going" and a new goal as "still going". Called once at startup, before
   * anything can drive a run, this settles them (spec §53):
   *
   * - the run is paused with the reason `interrupted`, so it offers Resume;
   * - tasks a dead process had claimed become ready again;
   * - turns cut off mid-answer are closed as failed, saying why.
   *
   * Nothing is started: resuming spends the person's quota and stays their
   * decision.
   */
  async recoverInterruptedRuns(): Promise<{ runs: number; turns: number }> {
    const rows = await this.#db
      .select({ id: teamRuns.id })
      .from(teamRuns)
      .where(inArray(teamRuns.status, ["running", "pending"]));
    let runs = 0;
    let turns = 0;
    const now = new Date();
    for (const { id } of rows) {
      if (this.#active.has(id)) {
        continue;
      }
      try {
        const snapshot = await this.#store.loadSnapshot(id);
        if (!snapshot) {
          continue;
        }
        for (const task of snapshot.tasks) {
          if (task.status === "claimed" || task.status === "running") {
            await this.#store.saveTask({ ...task, status: "ready", startedAt: null });
          }
        }
        for (const turn of snapshot.turns) {
          if (turn.status === "running") {
            turns += 1;
            await this.#store.saveTurn({
              ...turn,
              status: "failed",
              error: "Interrupted: AI Workbench stopped while this turn was running.",
              finishedAt: now,
            });
          }
        }
        await this.#store.saveRun({
          ...snapshot.run,
          status: "paused",
          stopReason: "interrupted",
        });
        runs += 1;
      } catch (error) {
        // One unreadable run must not keep the others stuck.
        this.#logger.warn("Interrupted run could not be recovered", {
          runId: id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    if (runs > 0) {
      this.#logger.info("Recovered interrupted team runs", { runs, turns });
    }
    return { runs, turns };
  }

  /** Picks a persisted run back up after a restart or a pause (spec §53). */
  async resumeRun(runId: string): Promise<TeamRun> {
    if (this.#active.has(runId)) {
      return this.#active.get(runId)!.service.run;
    }
    const snapshot = await this.#store.loadSnapshot(runId);
    if (!snapshot) {
      throw new TeamRunNotFoundError(runId);
    }
    if (snapshot.run.status === "completed" || snapshot.run.status === "cancelled") {
      return snapshot.run;
    }
    // Crash/restart recovery (spec §53): tasks left claimed/running by a dead
    // process must become runnable again, or the run stalls forever with
    // inFlight > 0 and nothing to wait for. Finished runs are returned above.
    for (const task of snapshot.tasks) {
      if (task.status === "claimed" || task.status === "running") {
        const reset: typeof task = { ...task, status: "ready", startedAt: null };
        await this.#store.saveTask(reset);
        const index = snapshot.tasks.findIndex((entry) => entry.id === task.id);
        if (index >= 0) {
          snapshot.tasks[index] = reset;
        }
      }
    }
    // A turn still open belongs to a process that is gone; left open, its
    // member reads as working forever.
    for (const [index, turn] of snapshot.turns.entries()) {
      if (turn.status === "running") {
        const closed = {
          ...turn,
          status: "failed" as const,
          error: turn.error ?? "Interrupted: AI Workbench stopped while this turn was running.",
          finishedAt: turn.finishedAt ?? new Date(),
        };
        await this.#store.saveTurn(closed);
        snapshot.turns[index] = closed;
      }
    }
    const team = await this.require(snapshot.run.teamId);
    this.#drive(team, await this.#runFolder(team, snapshot.run.workspaceId), snapshot);
    return snapshot.run;
  }

  /**
   * A note from the person to a running team. It goes to the lead (or to
   * everyone on a team without one) and the lead reads it on its next turn —
   * a priority turn alongside any batch still working, never after it, so a
   * note never waits behind long member turns. Files travel with it the way
   * a solo chat sends them.
   */
  async sendNote(
    runId: string,
    content: string,
    attachments: readonly Pick<MessageAttachment, "path">[] = [],
  ): Promise<TeamMessage> {
    const active = this.#active.get(runId);
    const status = active?.service.run.status;
    if (!active || (status !== "running" && status !== "pending")) {
      throw new Error("This run is not going; give the team a new goal instead.");
    }
    const kept = await this.#keepTeamAttachments(runId, attachments);
    const message = await active.service.sendMessage({
      from: "user",
      to: active.service.team.leadAgentId ?? "*",
      type: "request",
      content,
      attachments: kept,
    });
    // Wake the lead even while members are working; the orchestrator turns
    // the flag into a priority lead turn. Never throws: the note is kept
    // even if the nudge fails (the loop also polls unread user mail).
    try {
      active.orchestrator.notifyLeadMessage();
    } catch (error) {
      this.#logger.warn("Lead interrupt nudge failed", {
        runId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return message;
  }

  /**
   * Files going with a team message, checked on disk and copied into the run's
   * own folder. No capability gate here: every adapter receives the same
   * `AgentMessage.attachments` and applies its own profile flags, so the core
   * stays provider-independent.
   */
  async #keepTeamAttachments(
    runId: string,
    attachments: readonly Pick<MessageAttachment, "path">[],
  ): Promise<MessageAttachment[]> {
    if (attachments.length === 0) {
      return [];
    }
    const inspected = await inspectAttachments(attachments);
    if (!this.#attachmentsDirectory) {
      return inspected;
    }
    return keepAttachments(inspected, join(this.#attachmentsDirectory, runId, createId("files")));
  }

  async pauseRun(runId: string): Promise<TeamRun> {
    const active = this.#active.get(runId);
    if (!active) {
      const snapshot = await this.getSnapshot(runId);
      if (snapshot.run.status === "running") {
        const paused = { ...snapshot.run, status: "paused" as const, stopReason: "paused" as const, finishedAt: new Date() };
        await this.#store.saveRun(paused);
        this.#publish({ type: "TEAM_FINISHED", runId, status: "paused", stopReason: "paused", outcome: null });
        return paused;
      }
      return snapshot.run;
    }
    return active.orchestrator.pause();
  }

  async cancelRun(runId: string): Promise<TeamRun> {
    const active = this.#active.get(runId);
    if (!active) {
      const snapshot = await this.getSnapshot(runId);
      if (snapshot.run.status === "running" || snapshot.run.status === "paused") {
        const cancelled = { ...snapshot.run, status: "cancelled" as const, stopReason: "cancelled" as const, finishedAt: new Date() };
        await this.#store.saveRun(cancelled);
        this.#publish({ type: "TEAM_FINISHED", runId, status: "cancelled", stopReason: "cancelled", outcome: null });
        return cancelled;
      }
      return snapshot.run;
    }
    const stopped = await active.orchestrator.cancel("cancelled");
    await active.orchestrator.dispose().catch(() => undefined);
    this.#active.delete(runId);
    this.#publish({
      type: "TEAM_FINISHED",
      runId,
      status: "cancelled",
      stopReason: "cancelled",
      outcome: null,
    });
    return stopped;
  }

  /** Stops every run working in a workspace, before the workspace goes. */
  async cancelRunsIn(workspaceId: string): Promise<void> {
    const runs = [...this.#active]
      .filter(([, active]) => active.service.run.workspaceId === workspaceId)
      .map(([runId]) => runId);
    for (const runId of runs) {
      await this.cancelRun(runId).catch((error: unknown) => {
        this.#logger.warn("Team run did not stop with its workspace", {
          runId,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }
  }

  isRunning(runId: string): boolean {
    return this.#active.has(runId);
  }

  /** Stops every run; a run in flight is paused, never left orphaned. */
  async shutdown(): Promise<void> {
    for (const [runId, active] of this.#active) {
      try {
        await active.orchestrator.pause();
        await active.orchestrator.dispose();
      } catch (error) {
        this.#logger.warn("Team run did not stop cleanly", {
          runId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    this.#active.clear();
  }

  // --- internals -----------------------------------------------------------

  /**
   * The folder a run works in: the team's own folder when the person set
   * one, otherwise the folder of the workspace the run was started from.
   */
  async #runFolder(team: TeamDefinition, workspaceId: string): Promise<string> {
    if (team.settings.workingDirectory) {
      return team.settings.workingDirectory;
    }
    const [workspace] = await this.#db
      .select()
      .from(workspaces)
      .where(eq(workspaces.id, workspaceId))
      .limit(1);
    if (!workspace) {
      throw new TeamWorkspaceError("The workspace this run was started from no longer exists.");
    }
    if (workspace.connectionId) {
      throw new TeamWorkspaceError(
        `"${workspace.name}" is on another machine; team agents run on this computer, so start the run from a local workspace.`,
      );
    }
    return workspace.path;
  }

  async #workspacePath(workspaceId: string): Promise<string> {
    const [workspace] = await this.#db
      .select()
      .from(workspaces)
      .where(eq(workspaces.id, workspaceId))
      .limit(1);
    return workspace?.path ?? "";
  }

  #drive(team: TeamDefinition, folder: string, snapshot: TeamRunSnapshot): void {
    // Every member works in the run's folder, whatever their rows once said.
    const running: TeamDefinition = {
      ...team,
      agents: team.agents.map((agent) => ({ ...agent, workingDirectory: folder })),
    };
    const service = new TeamService({
      team: running,
      snapshot,
      store: this.#store,
      logger: this.#logger,
      emit: (event) => this.#publish(event),
    });

    const runtime: AgentRuntime = {
      adapterFor: (agent) => this.#adapterForAgent(agent, service),
    };
    const orchestrator = new TeamOrchestrator({
      service,
      runtime,
      logger: this.#logger,
    });

    const finished = orchestrator
      .run()
      .catch((error: unknown) => {
        this.#logger.error("Team run failed", {
          runId: snapshot.run.id,
          error: error instanceof Error ? error.message : String(error),
        });
        return service.stop("failed", "tooManyFailures");
      })
      .then((run) => {
        if (run.status === "completed" && run.stopReason === "goalFinished") {
          void this.#rememberGoal(service);
        }
        return run;
      })
      .finally(() => {
        void orchestrator.dispose();
        this.#active.delete(snapshot.run.id);
      });

    this.#active.set(snapshot.run.id, { service, orchestrator, finished });
  }

  /**
   * Writes the finished goal to the shared memory. Best effort: a vault that
   * is gone or full never fails the run it describes.
   */
  async #rememberGoal(service: TeamService): Promise<void> {
    if (!this.#recordMemory) {
      return;
    }
    try {
      const snapshot = service.snapshot();
      const run = snapshot.run;
      const team = service.team;
      const members = team.agents.map((agent) => {
        const lead = agent.id === team.leadAgentId ? ", lead" : "";
        const model = agent.modelId ? ` · ${agent.modelId}` : "";
        return `- ${agent.displayName} (${agent.providerId}${model}${lead})${agent.role ? `: ${agent.role}` : ""}`;
      });
      const decisions = snapshot.decisions
        .filter((decision) => !decision.title.startsWith("Finished: "))
        .map((decision) => `- ${decision.title}: ${decision.decision.slice(0, 400)}`);
      const done = snapshot.tasks.filter((task) => task.status === "completed");
      const lines = [
        `Team "${team.name}" finished a goal on ${new Date().toISOString().slice(0, 10)}.`,
        `Working folder: ${team.agents[0]?.workingDirectory ?? "unknown"}`,
        "",
        "## Goal",
        run.goal.slice(0, 2000),
        "",
        "## Outcome",
        (run.outcome ?? "No outcome was written.").slice(0, 4000),
        "",
        `## Tasks (${done.length} of ${snapshot.tasks.length} done)`,
        ...done.slice(0, 30).map((task) => `- ${task.title}`),
        ...(decisions.length > 0 ? ["", "## Decisions", ...decisions.slice(0, 20)] : []),
        "",
        "## Team",
        ...members,
      ];
      await this.#recordMemory({
        title: `Team goal: ${run.goal.replace(/\s+/g, " ").slice(0, 80)}`,
        content: lines.join("\n"),
      });
    } catch (error) {
      this.#logger.warn("Finished goal could not be kept in memory", {
        runId: service.run.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  #publish(event: TeamEvent): void {
    this.#events.publish({ type: "team.event", event });
  }

  /**
   * The adapter an agent talks through. A provider that speaks MCP is handed
   * the team MCP server as one of its own MCP servers, scoped to the agent;
   * anything else runs exactly as before on action blocks.
   */
  #adapterForAgent(agent: AgentDefinition, service: TeamService): AIProviderAdapter | null {
    const inner = this.#providers.get(agent.providerId);
    if (!inner) {
      return null;
    }
    if (!this.#mcp && !this.#teamMcp) {
      return inner;
    }
    const mcp = this.#mcp;
    return new TeamScopedAdapter(
      inner,
      () => this.#toolAccessFor(agent, inner, service),
      this.#logger,
      mcp ? (ids) => mcp.instructionsFor(ids) : undefined,
    );
  }

  /** The stdio entry for this agent's scoped team server, when configured. */
  #teamMcpServerFor(scope: TeamMcpScope): McpServerConfig | null {
    const launch = this.#teamMcp;
    if (!launch) {
      return null;
    }
    return describeTeamMcpServer(scope, launch);
  }

  /**
   * What a team agent may use: the servers selected for it — its own list
   * plus the session selection kept by the MCP service — resolved through the
   * tool bridge, plus its scoped team server. Decided by capability, never by
   * provider brand. Null when the provider speaks no MCP, so its turns run
   * exactly as before.
   */
  async #toolAccessFor(
    agent: AgentDefinition,
    adapter: AIProviderAdapter,
    service: TeamService,
  ): Promise<ProviderToolAccess | null> {
    const capabilities = await this.#safeCapabilities(adapter);
    if (!capabilities || !capabilities.supported.includes("mcp")) {
      return null;
    }
    const teamServer = this.#teamMcpServerFor({ runId: service.run.id, agentId: agent.id });
    const mcp = this.#mcp;
    if (mcp) {
      const selected = new Set<string>(agent.mcpServers);
      try {
        const enabled = await mcp.enabledForSession(`${service.run.id}:${agent.id}`);
        for (const id of enabled) {
          selected.add(id);
        }
      } catch (error) {
        this.#logger.warn("Team session servers could not be resolved", {
          runId: service.run.id,
          agentId: agent.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      // The team server is scoped per agent and added below, never taken
      // unscoped from the session selection.
      selected.delete(TEAM_MCP_SERVER_ID);
      if (selected.size > 0) {
        try {
          const plan = this.#toolBridge.plan({
            capabilities,
            enabledServerIds: [...selected],
            configs: await mcp.list(),
            statuses: mcp.statuses(),
            toolsFor: (ids) => mcp.manager.toolsForSession(ids),
          });
          for (const entry of plan.unavailable) {
            this.#logger.warn("Team MCP server is enabled but unusable", {
              runId: service.run.id,
              agentId: agent.id,
              serverId: entry.id,
              reason: entry.reason,
            });
          }
          if (plan.kind === "provider-mcp") {
            const servers = [...plan.mcpServers];
            if (teamServer && !servers.some((server) => server.id === teamServer.id)) {
              servers.push(teamServer);
            }
            return { kind: "provider-mcp", mcpServers: servers, hostTools: [] };
          }
        } catch (error) {
          this.#logger.warn("Team tool access could not be planned", {
            runId: service.run.id,
            agentId: agent.id,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }
    return teamServer ? { kind: "provider-mcp", mcpServers: [teamServer], hostTools: [] } : null;
  }

  async #safeCapabilities(adapter: AIProviderAdapter): Promise<ProviderCapabilities | null> {
    try {
      return await adapter.getCapabilities();
    } catch {
      return null;
    }
  }

  async #withAgents(row: TeamRow): Promise<TeamDefinition> {
    const agents = await this.#db
      .select()
      .from(teamAgents)
      .where(eq(teamAgents.teamId, row.id))
      .orderBy(asc(teamAgents.position));
    return {
      id: row.id,
      name: row.name,
      workspaceId: row.workspaceId,
      leadAgentId: row.leadAgentId,
      agents: agents.map(toAgent),
      settings: teamSettingsSchema.parse(row.settings ?? {}) as TeamSettings,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }
}

function toAgent(row: TeamAgentRow): AgentDefinition {
  return {
    id: row.id,
    displayName: row.displayName,
    providerId: row.providerId,
    ...(row.modelId ? { modelId: row.modelId } : {}),
    role: row.role,
    workingDirectory: row.workingDirectory,
    skills: row.skills,
    plugins: row.plugins,
    mcpServers: row.mcpServers,
    settings: row.settings,
  };
}

function toAgentRow(agent: AgentDefinition, teamId: string): Omit<TeamAgentRow, "position"> {
  return {
    id: agent.id,
    teamId,
    displayName: agent.displayName,
    providerId: agent.providerId,
    modelId: agent.modelId ?? null,
    role: agent.role,
    workingDirectory: agent.workingDirectory,
    skills: agent.skills,
    plugins: agent.plugins,
    mcpServers: agent.mcpServers,
    settings: agent.settings,
  };
}

/**
 * One team agent's view of its provider.
 *
 * Every call is the inner adapter's own; only session creation carries what
 * the team resolved for the agent — the servers selected for it plus its
 * scoped team MCP server. A resolution failure keeps the turn running without
 * tool access rather than failing it, exactly like the session path does.
 */
class TeamScopedAdapter implements AIProviderAdapter {
  readonly metadata: ProviderMetadata;
  readonly #inner: AIProviderAdapter;
  readonly #resolve: () => Promise<ProviderToolAccess | null>;
  readonly #logger: Logger;
  readonly #lookup: ServerInstructionsLookup | undefined;

  authenticate?: (request?: AuthRequest) => Promise<AuthResult>;
  logout?: () => Promise<void>;
  refreshModels?: () => Promise<ModelInfo[]>;
  getModelsUpdatedAt?: () => Date | null;
  resumeSession?: (
    providerSessionId: string,
    config: ProviderSessionConfig,
  ) => Promise<ProviderSessionInfo>;
  getUsage?: () => Promise<ProviderUsageSnapshot>;
  describeInteractiveLaunch?: (request: InteractiveLaunchRequest) => Promise<InteractiveLaunch>;
  discoverImportables?: (request: {
    readonly workspacePath?: string;
  }) => Promise<ProviderImportables>;
  describeLogin?: () => Promise<InteractiveLaunch | null>;

  constructor(
    inner: AIProviderAdapter,
    resolve: () => Promise<ProviderToolAccess | null>,
    logger: Logger,
    lookup?: ServerInstructionsLookup,
  ) {
    this.#inner = inner;
    this.#resolve = resolve;
    this.#logger = logger;
    this.#lookup = lookup;
    this.metadata = inner.metadata;
    const authenticate = inner.authenticate?.bind(inner);
    if (authenticate) {
      this.authenticate = authenticate;
    }
    const logout = inner.logout?.bind(inner);
    if (logout) {
      this.logout = logout;
    }
    const refreshModels = inner.refreshModels?.bind(inner);
    if (refreshModels) {
      this.refreshModels = refreshModels;
    }
    const getModelsUpdatedAt = inner.getModelsUpdatedAt?.bind(inner);
    if (getModelsUpdatedAt) {
      this.getModelsUpdatedAt = getModelsUpdatedAt;
    }
    const resumeSession = inner.resumeSession?.bind(inner);
    if (resumeSession) {
      this.resumeSession = async (providerSessionId, config) =>
        resumeSession(providerSessionId, await this.#withAccess(config));
    }
    const getUsage = inner.getUsage?.bind(inner);
    if (getUsage) {
      this.getUsage = getUsage;
    }
    const describeInteractiveLaunch = inner.describeInteractiveLaunch?.bind(inner);
    if (describeInteractiveLaunch) {
      this.describeInteractiveLaunch = describeInteractiveLaunch;
    }
    const discoverImportables = inner.discoverImportables?.bind(inner);
    if (discoverImportables) {
      this.discoverImportables = discoverImportables;
    }
    const describeLogin = inner.describeLogin?.bind(inner);
    if (describeLogin) {
      this.describeLogin = describeLogin;
    }
  }

  async initialize(context: ProviderContext): Promise<void> {
    await this.#inner.initialize(context);
  }

  async dispose(): Promise<void> {
    await this.#inner.dispose();
  }

  async detectInstallation(): Promise<InstallationStatus> {
    return this.#inner.detectInstallation();
  }

  async getAuthenticationStatus(): Promise<AuthStatus> {
    return this.#inner.getAuthenticationStatus();
  }

  async getCapabilities(): Promise<ProviderCapabilities> {
    return this.#inner.getCapabilities();
  }

  async listModels(): Promise<ModelInfo[]> {
    return this.#inner.listModels();
  }

  async createSession(config: ProviderSessionConfig): Promise<ProviderSessionInfo> {
    return this.#inner.createSession(await this.#withAccess(config));
  }

  sendMessage(
    session: ProviderSessionHandle,
    message: AgentMessage,
  ): AsyncIterable<ProviderEvent> {
    return this.#inner.sendMessage(session, message);
  }

  async cancel(session: ProviderSessionHandle): Promise<void> {
    await this.#inner.cancel(session);
  }

  async destroySession(session: ProviderSessionHandle): Promise<void> {
    await this.#inner.destroySession(session);
  }

  async #withAccess(config: ProviderSessionConfig): Promise<ProviderSessionConfig> {
    let access: ProviderToolAccess | null;
    try {
      access = await this.#resolve();
    } catch (error) {
      this.#logger.warn("Team tool access could not be resolved; continuing without it", {
        error: error instanceof Error ? error.message : String(error),
      });
      return config;
    }
    if (!access) {
      return config;
    }
    const existing = config.toolAccess;
    const incoming = new Set(access.mcpServers.map((server) => server.id));
    const toolAccess: ProviderToolAccess = existing
      ? {
          kind: access.kind,
          mcpServers: [
            ...access.mcpServers,
            ...existing.mcpServers.filter((server) => !incoming.has(server.id)),
          ],
          hostTools: access.hostTools,
        }
      : access;
    // A member is told what its servers are for — the shared memory first of
    // all — the same way a solo session is.
    const systemInstructions = withServerGuidance(config.systemInstructions, toolAccess, this.#lookup);
    return {
      ...config,
      toolAccess,
      ...(systemInstructions ? { systemInstructions } : {}),
    };
  }
}
