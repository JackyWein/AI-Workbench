import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeTempDirectory, removeTempDirectory } from "@ai-workbench/test-support";
import { createDatabase, runMigrations, type DatabaseHandle } from "@ai-workbench/database";
import { MockProviderAdapter } from "@ai-workbench/provider-mock";
import type { AppEvent, TeamEvent } from "@ai-workbench/shared";
import { EventBus } from "../event-bus.js";
import { createNullLogger } from "../logger.js";
import { ProviderManager } from "../provider-manager.js";
import { TeamManager } from "../team-manager.js";
import { WorkspaceManager } from "../workspace-manager.js";

interface TestApp {
  readonly events: EventBus;
  readonly database: DatabaseHandle;
  readonly workspaces: WorkspaceManager;
  readonly teams: TeamManager;
  readonly teamEvents: TeamEvent[];
  dispose(): Promise<void>;
}

async function bootApp(directory: string): Promise<TestApp> {
  const logger = createNullLogger();
  const database = createDatabase({ file: join(directory, "test.db") });
  await runMigrations(database.client);

  const events = new EventBus();
  const teamEvents: TeamEvent[] = [];
  events.subscribe((event: AppEvent) => {
    if (event.type === "team.event") {
      teamEvents.push(event.event);
    }
  });

  const providers = new ProviderManager({
    logger,
    stateDirectory: join(directory, "providers"),
  });
  await providers.register(
    new MockProviderAdapter({ chunkDelayMs: 0, startupDelayMs: 0 }),
  );

  const workspaces = new WorkspaceManager({ db: database.db, events, logger });
  const teams = new TeamManager({ db: database.db, events, logger, providers });

  return {
    events,
    database,
    workspaces,
    teams,
    teamEvents,
    dispose: async () => {
      await teams.shutdown();
      await providers.dispose();
      database.close();
    },
  };
}

/** Waits for the run to leave "running", which is when the loop has settled. */
async function settle(app: TestApp, runId: string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const snapshot = await app.teams.getSnapshot(runId);
    if (snapshot.run.status !== "running" && snapshot.run.status !== "pending") {
      return;
    }
    if (Date.now() > deadline) {
      throw new Error(`Run ${runId} is still ${snapshot.run.status}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe("team runs in the application", () => {
  let directory: string;
  let app: TestApp;

  beforeEach(async () => {
    directory = await makeTempDirectory("ai-workbench-team-");
    app = await bootApp(directory);
  });

  afterEach(async () => {
    await app.dispose();
    await removeTempDirectory(directory);
  });

  async function makeTeam(): Promise<{ teamId: string; workspaceId: string }> {
    const workspace = await app.workspaces.create({ name: "Demo", path: directory });
    const team = await app.teams.create({
      workspaceId: workspace.id,
      workingDirectory: workspace.path,
      name: "Delivery",
      agents: [
        { displayName: "Lead", providerId: "mock", role: "plans the work" },
        { displayName: "Builder", providerId: "mock", role: "implements" },
        { displayName: "Reviewer", providerId: "mock", role: "reviews" },
      ],
    });
    return { teamId: team.id, workspaceId: workspace.id };
  }

  it("persists a team with its agents and a selectable lead", async () => {
    const { teamId } = await makeTeam();

    const stored = await app.teams.require(teamId);
    expect(stored.agents.map((agent) => agent.displayName)).toEqual([
      "Lead",
      "Builder",
      "Reviewer",
    ]);
    expect(stored.leadAgentId).toBe(stored.agents[0]?.id);

    const changed = await app.teams.setLeadAgent(teamId, stored.agents[1]!.id);
    expect(changed.leadAgentId).toBe(stored.agents[1]?.id);
  });

  it("runs a goal to completion and persists everything it produced", async () => {
    const { teamId } = await makeTeam();
    const run = await app.teams.startRun({ teamId, goal: "Add a health endpoint" });
    await settle(app, run.id);

    const snapshot = await app.teams.getSnapshot(run.id);
    expect(snapshot.run.status).toBe("completed");
    expect(snapshot.run.stopReason).toBe("goalFinished");
    expect(snapshot.tasks.length).toBeGreaterThanOrEqual(2);
    expect(snapshot.tasks.every((task) => task.status === "completed")).toBe(true);

    // The work went to the other agents, not back to the lead.
    const team = await app.teams.require(teamId);
    const lead = team.leadAgentId;
    const assignees = new Set(snapshot.tasks.map((task) => task.assignedTo));
    expect(assignees.size).toBeGreaterThanOrEqual(2);
    expect(assignees.has(lead)).toBe(false);

    expect(snapshot.artifacts.length).toBeGreaterThanOrEqual(2);
    expect(snapshot.decisions.length).toBeGreaterThanOrEqual(1);

    // And the UI saw it happen.
    const types = app.teamEvents.map((event) => event.type);
    expect(types).toContain("TEAM_STARTED");
    expect(types).toContain("TASK_ASSIGNED");
    expect(types).toContain("TASK_COMPLETED");
    expect(types).toContain("TEAM_FINISHED");
  });

  it("continues a run after a restart of the application", async () => {
    const { teamId } = await makeTeam();
    const team = await app.teams.require(teamId);

    // A run that was interrupted leaves work in the graph.
    const run = await app.teams.startRun({ teamId, goal: "Survive a restart" });
    await app.teams.pauseRun(run.id);

    const store = app.teams;
    const paused = await store.getSnapshot(run.id);
    expect(["paused", "running", "completed"]).toContain(paused.run.status);

    // Everything is closed and reopened from the same database.
    await app.dispose();
    app = await bootApp(directory);

    const reopened = await app.teams.getSnapshot(run.id);
    expect(reopened.run.goal).toBe("Survive a restart");
    expect(reopened.run.teamId).toBe(team.id);

    if (reopened.run.status !== "completed") {
      await app.teams.resumeRun(run.id);
      await settle(app, run.id);
    }
    const finished = await app.teams.getSnapshot(run.id);
    expect(finished.run.status).toBe("completed");
    expect(finished.tasks.every((task) => task.status === "completed")).toBe(true);
  });

  it("cancels a run on request and says so", async () => {
    const { teamId } = await makeTeam();
    const run = await app.teams.startRun({ teamId, goal: "Something long" });
    const cancelled = await app.teams.cancelRun(run.id);

    expect(cancelled.status).toBe("cancelled");
    expect(app.teams.isRunning(run.id)).toBe(false);
  });

  it("refuses to run a team with no agents", async () => {
    const workspace = await app.workspaces.create({ name: "Empty", path: directory });
    const team = await app.teams.create({
      workspaceId: workspace.id,
      workingDirectory: workspace.path,
      name: "Nobody",
      agents: [],
    });
    await expect(
      app.teams.startRun({ teamId: team.id, goal: "impossible" }),
    ).rejects.toThrow(/at least one agent/);
  });
});
