import { asc, desc, eq } from "drizzle-orm";
import type { Database } from "@ai-workbench/database";
import { teamAgents, teamRuns, teams, type TeamAgentRow, type TeamRow } from "@ai-workbench/database";
import type {
  AgentDefinition,
  CreateTeamInputData,
  Logger,
  TeamDefinition,
  TeamEvent,
  TeamRun,
  TeamRunSnapshot,
  TeamSettings,
} from "@ai-workbench/shared";
import {
  agentDefinitionSchema,
  createTeamInputSchema,
  teamSettingsSchema,
} from "@ai-workbench/shared";
import {
  TeamOrchestrator,
  TeamService,
  newAgentId,
  newRunId,
  newTeamId,
  type AgentRuntime,
} from "@ai-workbench/team";
import type { EventBus } from "./event-bus.js";
import type { ProviderManager } from "./provider-manager.js";
import { SqlTeamRunStore, toRun } from "./team-store.js";

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

export interface TeamManagerOptions {
  readonly db: Database;
  readonly events: EventBus;
  readonly logger: Logger;
  readonly providers: ProviderManager;
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
  readonly #active = new Map<string, ActiveRun>();

  constructor(options: TeamManagerOptions) {
    this.#db = options.db;
    this.#events = options.events;
    this.#logger = options.logger.child("TEAM");
    this.#providers = options.providers;
    this.#store = new SqlTeamRunStore(options.db);
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
  async startRun(input: { teamId: string; goal: string }): Promise<TeamRun> {
    const team = await this.require(input.teamId);
    if (team.agents.length === 0) {
      throw new Error("A team needs at least one agent before it can run");
    }

    const now = new Date();
    const run: TeamRun = {
      id: newRunId(),
      teamId: team.id,
      workspaceId: team.workspaceId,
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
      limits: team.settings.limits,
      agentCalls: 0,
      failures: 0,
      messageCount: 0,
      createdAt: now,
      startedAt: null,
      finishedAt: null,
    };
    await this.#store.saveRun(run);

    this.#drive(team, {
      run,
      tasks: [],
      messages: [],
      decisions: [],
      artifacts: [],
    });
    return run;
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
    const team = await this.require(snapshot.run.teamId);
    this.#drive(team, snapshot);
    return snapshot.run;
  }

  async pauseRun(runId: string): Promise<TeamRun> {
    const active = this.#active.get(runId);
    if (!active) {
      return this.getSnapshot(runId).then((snapshot) => snapshot.run);
    }
    return active.orchestrator.pause();
  }

  async cancelRun(runId: string): Promise<TeamRun> {
    const active = this.#active.get(runId);
    if (!active) {
      const snapshot = await this.getSnapshot(runId);
      return snapshot.run;
    }
    await active.orchestrator.pause();
    const stopped = await active.service.stop("cancelled", "cancelled");
    await active.orchestrator.dispose();
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

  #drive(team: TeamDefinition, snapshot: TeamRunSnapshot): void {
    const service = new TeamService({
      team,
      snapshot,
      store: this.#store,
      logger: this.#logger,
      emit: (event) => this.#publish(event),
    });

    const runtime: AgentRuntime = {
      adapterFor: (agent) => this.#providers.get(agent.providerId) ?? null,
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
      .finally(() => {
        void orchestrator.dispose();
        this.#active.delete(snapshot.run.id);
      });

    this.#active.set(snapshot.run.id, { service, orchestrator, finished });
  }

  #publish(event: TeamEvent): void {
    this.#events.publish({ type: "team.event", event });
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
