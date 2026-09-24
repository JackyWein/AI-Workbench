import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeTempDirectory, removeTempDirectory } from "@ai-workbench/test-support";
import { createDatabase, runMigrations, type DatabaseHandle } from "@ai-workbench/database";
import { MockProviderAdapter } from "@ai-workbench/provider-mock";
import type { ProviderSessionConfig, ProviderSessionInfo } from "@ai-workbench/provider-base";
import type { AppEvent, TeamEvent } from "@ai-workbench/shared";
import { EventBus } from "../event-bus.js";
import { createNullLogger } from "../logger.js";
import { ProviderManager } from "../provider-manager.js";
import { TeamManager } from "../team-manager.js";
import { WorkspaceManager } from "../workspace-manager.js";

/** The mock provider, noting the folder every agent session was opened in. */
class FolderRecordingMock extends MockProviderAdapter {
  readonly folders: string[] = [];

  override async createSession(config: ProviderSessionConfig): Promise<ProviderSessionInfo> {
    this.folders.push(config.workingDirectory);
    return super.createSession(config);
  }
}

interface TestApp {
  readonly events: EventBus;
  readonly folders: string[];
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
  const mock = new FolderRecordingMock({ chunkDelayMs: 0, startupDelayMs: 0 });
  await providers.register(mock);

  const workspaces = new WorkspaceManager({ db: database.db, events, logger });
  const teams = new TeamManager({ db: database.db, events, logger, providers });

  return {
    events,
    folders: mock.folders,
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

  it("refuses to work outside the workspace unless the person allows it", async () => {
    const { teamId } = await makeTeam();
    const outside = resolve(directory, "..", "elsewhere");

    // The default is the workspace: a team never wanders off on its own.
    const untouched = await app.teams.require(teamId);
    expect(untouched.settings.allowOutsideWorkspace).toBe(false);
    expect(untouched.settings.workingDirectory).toBeNull();
    expect(untouched.agents[0]?.workingDirectory).toBe(directory);

    await expect(
      app.teams.setWorkingDirectory(teamId, outside),
    ).rejects.toThrow(/outside this team's workspace/);

    // Said yes on purpose: now the folder is allowed and every member follows.
    const moved = await app.teams.setWorkingDirectory(teamId, outside, true);
    expect(moved.settings.allowOutsideWorkspace).toBe(true);
    expect(moved.settings.workingDirectory).toBe(outside);
    expect(moved.agents.every((agent) => agent.workingDirectory === outside)).toBe(true);

    // Saying no again hands the workspace folder back.
    const back = await app.teams.setWorkingDirectory(teamId, null, false);
    expect(back.settings.workingDirectory).toBeNull();
    expect(back.settings.allowOutsideWorkspace).toBe(false);
  });

  it("works in the workspace a run is started from, not where the team was made", async () => {
    const { teamId } = await makeTeam();
    const elsewhere = join(directory, "other-project");
    await mkdir(elsewhere, { recursive: true });
    const other = await app.workspaces.create({ name: "Other", path: elsewhere });

    const run = await app.teams.startRun({ teamId, goal: "Ship it", workspaceId: other.id });
    expect(run.workspaceId).toBe(other.id);
    await settle(app, run.id);

    expect(app.folders.length).toBeGreaterThan(0);
    expect(new Set(app.folders)).toEqual(new Set([other.path]));
  });

  it("works in the team's own folder when the person set one", async () => {
    const { teamId } = await makeTeam();
    await mkdir(join(directory, "other"), { recursive: true });
    const other = await app.workspaces.create({ name: "Other", path: join(directory, "other") });
    const fixed = resolve(directory, "..", "fixed-folder");
    await app.teams.setWorkingDirectory(teamId, fixed, true);

    const run = await app.teams.startRun({ teamId, goal: "Ship it", workspaceId: other.id });
    await settle(app, run.id);
    expect(new Set(app.folders)).toEqual(new Set([fixed]));
  });

  it("edits a team: name, members, what they run on and who leads", async () => {
    const { teamId } = await makeTeam();
    const before = await app.teams.require(teamId);
    const [lead, builder] = before.agents;

    const after = await app.teams.update({
      teamId,
      name: "Delivery two",
      instructions: "Keep it small.",
      agents: [
        { id: builder!.id, displayName: "Builder", providerId: "mock", modelId: "mock-fast", role: "builds" },
        { id: lead!.id, displayName: "Lead", providerId: "mock", role: "plans" },
        { displayName: "Tester", providerId: "mock", role: "tests" },
      ],
      leadAgentIndex: 1,
    });

    expect(after.name).toBe("Delivery two");
    expect(after.settings.instructions).toBe("Keep it small.");
    expect(after.agents.map((agent) => agent.displayName)).toEqual(["Builder", "Lead", "Tester"]);
    // The members kept their ids; the reviewer left; the tester is new.
    expect(after.agents[0]).toMatchObject({ id: builder!.id, modelId: "mock-fast", role: "builds" });
    expect(after.agents[1]?.id).toBe(lead!.id);
    expect(after.agents.some((agent) => agent.displayName === "Reviewer")).toBe(false);
    expect(after.leadAgentId).toBe(lead!.id);
  });

  it("refuses to change a team while one of its runs is going", async () => {
    const { teamId } = await makeTeam();
    const run = await app.teams.startRun({ teamId, goal: "Ship it" });
    const snapshot = await app.teams.getSnapshot(run.id);
    if (snapshot.run.status === "running") {
      await expect(app.teams.update({ teamId, name: "Renamed" })).rejects.toThrow(/run going/);
    }
    await settle(app, run.id);
    await expect(app.teams.update({ teamId, name: "Renamed" })).resolves.toMatchObject({
      name: "Renamed",
    });
  });

  it("hands a note from the person to the lead of a going run, and only then", async () => {
    const { teamId } = await makeTeam();
    const run = await app.teams.startRun({ teamId, goal: "Ship it" });
    const note = await app.teams.sendNote(run.id, "Use the blue palette.");
    const team = await app.teams.require(teamId);
    expect(note).toMatchObject({ from: "user", to: team.leadAgentId, content: "Use the blue palette." });
    await settle(app, run.id);
    const snapshot = await app.teams.getSnapshot(run.id);
    expect(snapshot.messages.some((message) => message.from === "user")).toBe(true);
    await expect(app.teams.sendNote(run.id, "Too late")).rejects.toThrow(/not going/);
  });

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

    // What each member wrote survives the restart too, read back from the
    // database rather than from a run in memory.
    await app.dispose();
    app = await bootApp(directory);
    const stored = await app.teams.getSnapshot(run.id);
    expect(stored.turns.length).toBeGreaterThanOrEqual(stored.tasks.length);
    expect(stored.turns.every((turn) => turn.status !== "running" && turn.output.length > 0)).toBe(true);
    expect(stored.turns.every((turn) => turn.startedAt instanceof Date)).toBe(true);
  });

  it("cancels a run on request and says so", async () => {
    const { teamId } = await makeTeam();
    const run = await app.teams.startRun({ teamId, goal: "Something long" });
    const cancelled = await app.teams.cancelRun(run.id);

    expect(cancelled.status).toBe("cancelled");
    expect(app.teams.isRunning(run.id)).toBe(false);
  });

  it("stops the runs working in a workspace, and only those, when it goes", async () => {
    const { teamId } = await makeTeam();
    const run = await app.teams.startRun({ teamId, goal: "Something long" });
    await app.teams.cancelRunsIn("some-other-workspace");
    expect(app.teams.isRunning(run.id)).toBe(true);

    await app.teams.cancelRunsIn(run.workspaceId);
    expect(app.teams.isRunning(run.id)).toBe(false);
    expect((await app.teams.getSnapshot(run.id)).run.status).toBe("cancelled");
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
