import { describe, expect, it } from "vitest";
import type { AIProviderAdapter } from "@ai-workbench/provider-base";
import type { AgentDefinition, TeamDefinition, TeamRunSnapshot } from "@ai-workbench/shared";
import { InMemoryTeamRunStore } from "../store.js";
import { TeamService } from "../service.js";
import { TeamOrchestrator } from "../orchestrator.js";
import { newRunId, newTaskId, newTeamId } from "../ids.js";

const nullLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => nullLogger,
};

function agent(id: string): AgentDefinition {
  return {
    id,
    displayName: id,
    providerId: "mock",
    role: "",
    workingDirectory: "/tmp",
    skills: [],
    plugins: [],
    mcpServers: [],
    settings: {},
  };
}

function teamOf(agents: AgentDefinition[], leadAgentId: string): TeamDefinition {
  const now = new Date();
  return {
    id: newTeamId(),
    name: "Stall",
    workspaceId: "ws_1",
    leadAgentId,
    agents,
    settings: {
      separateWorktrees: false,
      instructions: "",
      allowOutsideWorkspace: false,
      workingDirectory: null,
      limits: {
        maxAgentCalls: 3,
        maxTasks: 50,
        maxTaskDepth: 8,
        maxRuntimeMinutes: 60,
        maxFailures: 10,
        maxConcurrentAgents: 3,
        maxMessages: 200,
        maxDelegationsPerTask: 4,
        agentTurnSilenceSeconds: 600,
      },
    },
    createdAt: now,
    updatedAt: now,
  };
}

function snapshotOf(team: TeamDefinition): TeamRunSnapshot {
  const now = new Date();
  return {
    run: {
      id: newRunId(),
      teamId: team.id,
      workspaceId: team.workspaceId,
      sessionId: null,
      goal: "Finish the unfinishable",
      status: "pending",
      stopReason: null,
      outcome: null,
      sharedState: { goal: "Finish the unfinishable", summary: "", currentPlan: null, importantContext: [] },
      limits: team.settings.limits,
      agentCalls: 0,
      failures: 0,
      messageCount: 0,
      createdAt: now,
      startedAt: null,
      finishedAt: null,
    },
    tasks: [],
    messages: [],
    decisions: [],
    artifacts: [],
    turns: [],
  };
}

/** A missing provider: every turn fails before spending a call. */
function noProvider(): AIProviderAdapter | null {
  return null;
}

describe("a stalled task graph", () => {
  it("warns once per blockade and stops instead of spinning forever", async () => {
    const team = teamOf([agent("lead")], "lead");
    const service = new TeamService({
      team,
      snapshot: snapshotOf(team),
      store: new InMemoryTeamRunStore(),
      logger: nullLogger,
      emit: () => {},
    });
    await service.start();
    const doomed = await service.createTask({ title: "Doomed", createdBy: "lead" });
    await service.failTask(doomed.id, "boom");
    // Blocked forever on a failed dependency: nothing can ever run again, and
    // with no provider every lead turn fails before spending a call — the
    // loop must still terminate instead of warning forever.
    await service.createTask({ title: "Waits on doomed", createdBy: "lead", dependencies: [doomed.id] });

    const orchestrator = new TeamOrchestrator({
      service,
      runtime: { adapterFor: noProvider },
      logger: nullLogger,
      turnTimeoutMs: 15_000,
    });
    const run = await orchestrator.run();
    await orchestrator.dispose();

    expect(run.stopReason).toBe("noWorkLeft");
    const stalled = service.snapshot().messages.filter((message) =>
      message.content.includes("Nothing can run"),
    );
    expect(stalled).toHaveLength(1);
    // One stall warning plus one failed-turn note per quiet pass — bounded,
    // never a mailbox flood up to the message budget.
    expect(service.snapshot().messages.length).toBeLessThan(10);
  }, 30_000);

  it("clears a stale stop reason when the run starts again", async () => {
    const team = teamOf([agent("lead")], "lead");
    const snapshot = snapshotOf(team);
    snapshot.run.status = "paused";
    snapshot.run.stopReason = "interrupted";
    const service = new TeamService({
      team,
      snapshot,
      store: new InMemoryTeamRunStore(),
      logger: nullLogger,
      emit: () => {},
    });
    const run = await service.start();
    expect(run.status).toBe("running");
    expect(run.stopReason).toBeNull();
  });

  it("heals a stale blocked label at claim instead of refusing forever", async () => {
    const team = teamOf([agent("lead"), agent("w1")], "lead");
    const snapshot = snapshotOf(team);
    const now = new Date();
    const depId = newTaskId();
    const waitingId = newTaskId();
    // As left by a crash/restart race: the dependency is completed, but the
    // waiting task still carries the "blocked" label. The scheduler picks by
    // the graph (runnable!) while claim read the label (refused!) — every
    // pass picked and refused the same task, logging millions of warnings
    // until the app froze and died.
    snapshot.tasks = [
      {
        id: depId,
        runId: snapshot.run.id,
        title: "Dep",
        description: "",
        status: "completed",
        createdBy: "lead",
        assignedTo: null,
        parentTaskId: null,
        dependencies: [],
        priority: 0,
        depth: 0,
        delegations: 0,
        result: "done",
        artifacts: [],
        error: null,
        createdAt: now,
        startedAt: now,
        completedAt: now,
      },
      {
        id: waitingId,
        runId: snapshot.run.id,
        title: "Waits",
        description: "",
        status: "blocked",
        createdBy: "lead",
        assignedTo: "w1",
        parentTaskId: null,
        dependencies: [depId],
        priority: 0,
        depth: 1,
        delegations: 0,
        result: null,
        artifacts: [],
        error: null,
        createdAt: now,
        startedAt: null,
        completedAt: null,
      },
    ];
    const service = new TeamService({
      team,
      snapshot,
      store: new InMemoryTeamRunStore(),
      logger: nullLogger,
      emit: () => {},
    });
    await service.start();
    const claimed = await service.claimTask(waitingId, "w1");
    expect(claimed.status).toBe("claimed");
  });
});
