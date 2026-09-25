import { mkdir, writeFile } from "node:fs/promises";
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
import { SqlTeamRunStore } from "../team-store.js";
import { WorkspaceManager } from "../workspace-manager.js";
import { GitService } from "@ai-workbench/workspace-git";
import { execCli } from "@ai-workbench/transport-cli";

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
  /** Notes the team manager kept in the shared memory. */
  readonly memoryNotes: Array<{ title: string; content: string }>;
  dispose(): Promise<void>;
}

async function bootApp(directory: string, options: { withGit?: boolean } = {}): Promise<TestApp> {
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
  const memoryNotes: Array<{ title: string; content: string }> = [];
  const teams = new TeamManager({
    db: database.db,
    events,
    logger,
    providers,
    recordMemory: async (note) => {
      memoryNotes.push({ ...note });
    },
    ...(options.withGit ? { folderHistory: new GitService({ logger }) } : {}),
  });

  return {
    events,
    folders: mock.folders,
    database,
    workspaces,
    teams,
    teamEvents,
    memoryNotes,
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

  it("lets safe changes through while a run is going, but not removals", async () => {
    const { teamId } = await makeTeam();
    const before = await app.teams.require(teamId);
    const run = await app.teams.startRun({ teamId, goal: "Ship it" });
    const snapshot = await app.teams.getSnapshot(run.id);
    if (snapshot.run.status === "running") {
      // Adding a member and renaming are safe: the live run picks them up.
      const grown = await app.teams.update({
        teamId,
        name: "Renamed",
        agents: [
          ...before.agents.map((agent) => ({
            id: agent.id,
            displayName: agent.displayName,
            providerId: agent.providerId,
            role: agent.role,
          })),
          { displayName: "Newcomer", providerId: "mock", role: "helps" },
        ],
      });
      expect(grown.name).toBe("Renamed");
      expect(grown.agents.map((agent) => agent.displayName)).toContain("Newcomer");
      // Removing a member mid-run is still refused: the run may wait on it.
      await expect(
        app.teams.update({
          teamId,
          agents: before.agents.slice(0, 2).map((agent) => ({
            id: agent.id,
            displayName: agent.displayName,
            providerId: agent.providerId,
            role: agent.role,
          })),
        }),
      ).rejects.toThrow(/run going/);
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

  it("keeps the chat when a finished run gets its next goal", async () => {
    const { teamId } = await makeTeam();
    const run = await app.teams.startRun({ teamId, goal: "First goal" });
    await settle(app, run.id);

    const before = await app.teams.getSnapshot(run.id);
    expect(before.run.status).toBe("completed");
    expect(before.run.outcome).toBeTruthy();
    expect(before.tasks.length).toBeGreaterThan(0);
    const tasksBefore = before.tasks.length;
    const messagesBefore = before.messages.length;

    // The next goal continues the same run instead of swapping the chat for
    // an empty one.
    const continued = await app.teams.continueRun({ runId: run.id, goal: "Second goal" });
    expect(continued.id).toBe(run.id);
    expect(continued.goal).toBe("Second goal");
    expect(continued.status).toBe("pending");
    await settle(app, run.id);

    const after = await app.teams.getSnapshot(run.id);
    // Nothing was cleared: the old work is all still there...
    expect(after.tasks.length).toBeGreaterThanOrEqual(tasksBefore);
    expect(after.messages.length).toBeGreaterThanOrEqual(messagesBefore + 1);
    expect(
      after.messages.some((message) => message.from === "user" && message.content === "Second goal"),
    ).toBe(true);
    // ...the previous outcome stays readable as a decision...
    expect(after.decisions.some((decision) => decision.decision === before.run.outcome)).toBe(
      true,
    );
    // ...and the new goal finished in the same timeline.
    expect(after.run.status).toBe("completed");
    expect(after.run.outcome).toContain("Second goal");
  });

  it("keeps a run with the session that started it, and never hands it to another", async () => {
    const { teamId } = await makeTeam();
    const run = await app.teams.startRun({ teamId, goal: "First goal", sessionId: "session_a" });
    expect(run.sessionId).toBe("session_a");
    await settle(app, run.id);
    const stored = (await app.teams.listRuns(teamId)).find((entry) => entry.id === run.id);
    expect(stored?.sessionId).toBe("session_a");

    // Continuing hands over the run's whole history: another session never may.
    await expect(
      app.teams.continueRun({ runId: run.id, goal: "Not mine", sessionId: "session_b" }),
    ).rejects.toThrow(/another session/);
    const continued = await app.teams.continueRun({
      runId: run.id,
      goal: "Second goal",
      sessionId: "session_a",
    });
    expect(continued.sessionId).toBe("session_a");
    await settle(app, run.id);

    // A run from before runs knew their session is claimed by the first
    // session that continues it, and is then that session's alone.
    const older = await app.teams.startRun({ teamId, goal: "An older run" });
    expect(older.sessionId).toBeNull();
    await settle(app, older.id);
    const claimed = await app.teams.continueRun({
      runId: older.id,
      goal: "Claim it",
      sessionId: "session_b",
    });
    expect(claimed.sessionId).toBe("session_b");
    await settle(app, older.id);
    await expect(
      app.teams.continueRun({ runId: older.id, goal: "Too late", sessionId: "session_a" }),
    ).rejects.toThrow(/another session/);
  });

  it("shows the code a member's turn changed as a diff, read from the folder", async () => {
    await app.dispose();
    app = await bootApp(directory, { withGit: true });
    const git = async (...args: string[]): Promise<void> => {
      const { exit } = await execCli({ executablePath: "git", args, cwd: directory });
      if (exit.code !== 0) {
        throw new Error(`git ${args.join(" ")} failed: ${exit.stderr}`);
      }
    };
    await git("init", "--initial-branch", "main");
    await git("config", "user.email", "test@example.com");
    await git("config", "user.name", "Test");
    await writeFile(join(directory, ".gitignore"), "*.db*\nproviders/\n");
    await git("add", ".");
    await git("commit", "-m", "start");

    // One member does the work, so the change is its own alone. (With
    // several writing the same file at once, a snapshot can catch another's
    // write half done; that case is marked, as the next test shows.)
    const workspace = await app.workspaces.create({ name: "Demo", path: directory });
    const team = await app.teams.create({
      workspaceId: workspace.id,
      workingDirectory: workspace.path,
      name: "Pair",
      agents: [
        { displayName: "Lead", providerId: "mock", role: "plans the work" },
        { displayName: "Builder", providerId: "mock", role: "implements" },
      ],
    });
    // The stand-in member writes this file, the way a real tool edits the project.
    const run = await app.teams.startRun({ teamId: team.id, goal: "Add the feature [write: src/feature.ts]" });
    await settle(app, run.id);

    const snapshot = await app.teams.getSnapshot(run.id);
    expect(snapshot.run.status).toBe("completed");
    const diffs = snapshot.artifacts.filter((artifact) => artifact.type === "diff");
    expect(diffs).toHaveLength(1);
    const first = diffs[0];
    expect(first?.path).toBe("src/feature.ts");
    expect(first?.content).toContain("+export const done = true;");
    expect(first?.metadata["source"]).toBe("folder");
    expect(first?.metadata["concurrent"]).toBe(false);
    // In the member's name, for its task.
    const builder = team.agents.find((agent) => agent.displayName === "Builder");
    expect(first?.createdBy).toBe(builder?.id);
    expect(first?.taskId).not.toBeNull();
  });

  it("says so when members changed the folder at the same time", async () => {
    await app.dispose();
    app = await bootApp(directory, { withGit: true });
    const git = async (...args: string[]): Promise<void> => {
      const { exit } = await execCli({ executablePath: "git", args, cwd: directory });
      if (exit.code !== 0) {
        throw new Error(`git ${args.join(" ")} failed: ${exit.stderr}`);
      }
    };
    await git("init", "--initial-branch", "main");
    await git("config", "user.email", "test@example.com");
    await git("config", "user.name", "Test");
    await writeFile(join(directory, ".gitignore"), "*.db*\nproviders/\n");
    await git("add", ".");
    await git("commit", "-m", "start");

    // Two members work on their tasks at once, in the same folder.
    const { teamId } = await makeTeam();
    const run = await app.teams.startRun({ teamId, goal: "Add the feature [write: src/feature.ts]" });
    await settle(app, run.id);

    const diffs = (await app.teams.getSnapshot(run.id)).artifacts.filter((artifact) => artifact.type === "diff");
    expect(diffs.length).toBeGreaterThan(0);
    // Whose change it was cannot be told apart then, and the entry says so.
    expect(diffs.every((artifact) => artifact.metadata["concurrent"] === true)).toBe(true);
    expect(String(diffs[0]?.metadata["reason"])).toContain("Other members were working at the same time");
  });

  it("refuses a new goal while the run is still going", async () => {
    const { teamId } = await makeTeam();
    const run = await app.teams.startRun({ teamId, goal: "Ship it" });
    await expect(app.teams.continueRun({ runId: run.id, goal: "Too soon" })).rejects.toThrow(
      /still going/,
    );
    await settle(app, run.id);
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

  it("keeps a finished goal in the shared memory", async () => {
    const { teamId } = await makeTeam();
    const run = await app.teams.startRun({ teamId, goal: "Remember what we did" });
    await settle(app, run.id);
    // The note is written right after the run ends.
    for (let attempt = 0; attempt < 50 && app.memoryNotes.length === 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect((await app.teams.getSnapshot(run.id)).run.stopReason).toBe("goalFinished");
    expect(app.memoryNotes).toHaveLength(1);
    expect(app.memoryNotes[0]?.title).toBe("Team goal: Remember what we did");
    expect(app.memoryNotes[0]?.content).toContain("## Outcome");
    expect(app.memoryNotes[0]?.content).toContain("Builder (mock");
  });

  it("settles a run a crash left going, so it can be resumed", async () => {
    const { teamId } = await makeTeam();
    const run = await app.teams.startRun({ teamId, goal: "Survive a crash" });
    await settle(app, run.id);

    // What a killed process leaves behind: the run still marked as going, a
    // task claimed by a member and that member's turn never closed.
    const store = new SqlTeamRunStore(app.database.db);
    const before = await app.teams.getSnapshot(run.id);
    const task = before.tasks[0];
    const turn = before.turns[0];
    expect(task).toBeDefined();
    expect(turn).toBeDefined();
    await store.saveRun({ ...before.run, status: "running", stopReason: null, finishedAt: null });
    await store.saveTask({ ...task!, status: "running", completedAt: null });
    await store.saveTurn({ ...turn!, status: "running", finishedAt: null, error: null });

    await app.dispose();
    app = await bootApp(directory);

    // Before recovery the run claims to be going with nothing behind it.
    expect((await app.teams.getSnapshot(run.id)).run.status).toBe("running");
    const recovered = await app.teams.recoverInterruptedRuns();
    expect(recovered).toEqual({ runs: 1, turns: 1 });

    const after = await app.teams.getSnapshot(run.id);
    expect(after.run.status).toBe("paused");
    expect(after.run.stopReason).toBe("interrupted");
    expect(after.tasks.find((entry) => entry.id === task!.id)?.status).toBe("ready");
    const closed = after.turns.find((entry) => entry.id === turn!.id);
    expect(closed?.status).toBe("failed");
    expect(closed?.error).toMatch(/Interrupted/);
    expect(closed?.finishedAt).toBeInstanceOf(Date);

    // A second start finds nothing more to do, and Resume finishes the work.
    expect(await app.teams.recoverInterruptedRuns()).toEqual({ runs: 0, turns: 0 });
    await app.teams.resumeRun(run.id);
    await settle(app, run.id);
    expect((await app.teams.getSnapshot(run.id)).run.status).toBe("completed");
  });

  it("refuses a second resume while the first is still attaching", async () => {
    const { teamId } = await makeTeam();
    const run = await app.teams.startRun({ teamId, goal: "Resume me twice" });
    await settle(app, run.id);

    // A paused run with nothing driving it, like after a crash recovery.
    const store = new SqlTeamRunStore(app.database.db);
    const finished = await app.teams.getSnapshot(run.id);
    await store.saveRun({ ...finished.run, status: "paused", stopReason: "paused", finishedAt: null });
    expect(app.teams.isRunning(run.id)).toBe(false);

    const started = app.teamEvents.filter(
      (event) => event.type === "TEAM_STARTED" && event.runId === run.id,
    ).length;
    const [first, second] = await Promise.allSettled([
      app.teams.resumeRun(run.id),
      app.teams.resumeRun(run.id),
    ]);
    const fulfilled = [first, second].filter((outcome) => outcome.status === "fulfilled");
    const rejected = [first, second].filter((outcome) => outcome.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    const reason = rejected[0];
    expect(reason && reason.status === "rejected" ? String(reason.reason) : "").toMatch(
      /already starting/,
    );

    // The resumed run leaves "paused" exactly once: a doubled resume would
    // have attached two orchestrators with two provider sessions per agent.
    // (Windows SQLite is slow: allow the attach its time instead of racing it.)
    let begins = started;
    for (let attempt = 0; attempt < 1500; attempt += 1) {
      begins = app.teamEvents.filter(
        (event) => event.type === "TEAM_STARTED" && event.runId === run.id,
      ).length;
      if (begins - started === 1) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(begins - started).toBe(1);

    await app.teams.cancelRun(run.id);
    await settle(app, run.id);
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
