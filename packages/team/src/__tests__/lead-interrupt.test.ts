import { describe, expect, it } from "vitest";
import { MockProviderAdapter } from "@ai-workbench/provider-mock";
import type { AIProviderAdapter } from "@ai-workbench/provider-base";
import type { AgentDefinition, TeamDefinition, TeamEvent, TeamRunSnapshot } from "@ai-workbench/shared";
import { InMemoryTeamRunStore } from "../store.js";
import { TeamService } from "../service.js";
import { TeamOrchestrator } from "../orchestrator.js";
import { newRunId, newTeamId } from "../ids.js";

const nullLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => nullLogger,
};

function agent(id: string, displayName: string): AgentDefinition {
  return {
    id,
    displayName,
    providerId: "mock",
    role: "",
    workingDirectory: "/tmp",
    skills: [],
    plugins: [],
    mcpServers: [],
    settings: {},
  };
}

describe("lead interrupt (verify)", () => {
  it("gives the lead a priority turn for a user note while members work", async () => {
    const agents = [agent("lead", "Lead"), agent("w1", "W1"), agent("w2", "W2")];
    const now = new Date();
    const team: TeamDefinition = {
      id: newTeamId(),
      name: "Checks",
      workspaceId: "ws_1",
      leadAgentId: "lead",
      agents,
      settings: {
        separateWorktrees: false,
        instructions: "",
        allowOutsideWorkspace: false,
        workingDirectory: null,
        limits: {
          maxAgentCalls: 30,
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
    const snapshot: TeamRunSnapshot = {
      run: {
        id: newRunId(),
        teamId: team.id,
        workspaceId: team.workspaceId,
        sessionId: null,
        goal: "Do the slow work",
        status: "pending",
        stopReason: null,
        outcome: null,
        sharedState: { goal: "Do the slow work", summary: "", currentPlan: null, importantContext: [] },
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
    const events: TeamEvent[] = [];
    const service = new TeamService({
      team,
      snapshot,
      store: new InMemoryTeamRunStore(),
      logger: nullLogger,
      emit: (event) => events.push(event),
    });
    await service.start();
    await service.createTask({ title: "Slow one", createdBy: "lead", assignedTo: "w1" });
    await service.createTask({ title: "Slow two", createdBy: "lead", assignedTo: "w2" });

    const base = new MockProviderAdapter({ chunkDelayMs: 0, startupDelayMs: 0 });
    await base.initialize({
      config: { id: "mock", adapterId: "mock", transport: "in-process", authType: "none" },
      logger: nullLogger,
      stateDirectory: "/tmp",
    });
    // Hold every member turn open so the user note lands mid-batch.
    const slow = {
      ...base,
      createSession: base.createSession.bind(base),
      async *sendMessage(handle: never, message: never) {
        await new Promise((resolve) => setTimeout(resolve, 600));
        yield* base.sendMessage(handle as never, message as never);
      },
    } as unknown as AIProviderAdapter;

    const orchestrator = new TeamOrchestrator({
      service,
      runtime: { adapterFor: () => slow },
      logger: nullLogger,
      turnTimeoutMs: 15_000,
    });

    const running = orchestrator.run();
    // The note lands while both workers are still in their slow turns.
    await new Promise((resolve) => setTimeout(resolve, 150));
    await service.sendMessage({
      from: "user",
      to: "lead",
      type: "request",
      content: "URGENT-LEAD-NOTE interrupt please re-plan",
    });
    orchestrator.notifyLeadMessage();

    const run = await running;
    await orchestrator.dispose();

    // No deadlock: the run finished one way or another.
    expect(["completed", "failed"]).toContain(run.status);
    // The lead actually took a turn while/after the note (lead turns own no task).
    const leadTurns = service.snapshot().turns.filter((t) => t.agentId === "lead" && t.taskId === null);
    expect(leadTurns.length).toBeGreaterThanOrEqual(1);
    // The user's note was consumed, not left unread.
    expect(service.peekUnread("lead", { from: "user" })).toHaveLength(0);
    // The lead turn ran *alongside* the batch, not after it: it started
    // before the workers' turns finished.
    const workerTurns = service
      .snapshot()
      .turns.filter((t) => (t.agentId === "w1" || t.agentId === "w2") && t.finishedAt !== null);
    expect(workerTurns.length).toBeGreaterThanOrEqual(1);
    const earliestLead = Math.min(...leadTurns.map((t) => t.startedAt.getTime()));
    const latestWorkerEnd = Math.max(...workerTurns.map((t) => t.finishedAt!.getTime()));
    expect(earliestLead).toBeLessThan(latestWorkerEnd);
  }, 30_000);
});
