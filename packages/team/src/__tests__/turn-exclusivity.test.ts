import { describe, expect, it } from "vitest";
import { MockProviderAdapter } from "@ai-workbench/provider-mock";
import type { AIProviderAdapter, ProviderSessionHandle } from "@ai-workbench/provider-base";
import type { AgentDefinition, TeamDefinition, TeamRunSnapshot } from "@ai-workbench/shared";
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
    name: "Exclusivity",
    workspaceId: "ws_1",
    leadAgentId,
    agents,
    settings: {
      instructions: "",
      allowOutsideWorkspace: false,
      workingDirectory: null,
      limits: {
        maxAgentCalls: 30,
        maxTasks: 50,
        maxTaskDepth: 8,
        maxRuntimeMinutes: 60,
        maxFailures: 10,
        maxConcurrentAgents: 4,
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
      goal: "Work in parallel where it is safe",
      status: "pending",
      stopReason: null,
      outcome: null,
      sharedState: { goal: "Work in parallel where it is safe", summary: "", currentPlan: null, importantContext: [] },
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

/**
 * A slow provider that counts how many turns run at once per conversation —
 * the one thing that must never exceed one: two turns resuming the same
 * provider session race its history, its session id and its cancel handle.
 */
async function countingProvider(delayMs: number): Promise<{
  adapter: AIProviderAdapter;
  peakPerSession: Map<string, number>;
  turnsPerSession: Map<string, number>;
}> {
  const base = new MockProviderAdapter({ chunkDelayMs: 0, startupDelayMs: 0 });
  await base.initialize({
    config: { id: "mock", adapterId: "mock", transport: "in-process", authType: "none" },
    logger: nullLogger,
    stateDirectory: "/tmp",
  });
  const inFlight = new Map<string, number>();
  const peakPerSession = new Map<string, number>();
  const turnsPerSession = new Map<string, number>();
  const adapter = {
    ...base,
    metadata: base.metadata,
    createSession: base.createSession.bind(base),
    destroySession: base.destroySession.bind(base),
    cancel: base.cancel.bind(base),
    async *sendMessage(handle: ProviderSessionHandle, message: never) {
      const key = handle.sessionId;
      const now = (inFlight.get(key) ?? 0) + 1;
      inFlight.set(key, now);
      peakPerSession.set(key, Math.max(peakPerSession.get(key) ?? 0, now));
      turnsPerSession.set(key, (turnsPerSession.get(key) ?? 0) + 1);
      try {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        yield* base.sendMessage(handle, message);
      } finally {
        inFlight.set(key, (inFlight.get(key) ?? 1) - 1);
      }
    },
  } as unknown as AIProviderAdapter;
  return { adapter, peakPerSession, turnsPerSession };
}

describe("one turn per agent at a time", () => {
  it("runs two tasks of the same member one after the other, never together", async () => {
    const team = teamOf([agent("lead"), agent("w1"), agent("w2")], "lead");
    const service = new TeamService({
      team,
      snapshot: snapshotOf(team),
      store: new InMemoryTeamRunStore(),
      logger: nullLogger,
      emit: () => {},
    });
    await service.start();
    await service.createTask({ title: "First for w1", createdBy: "lead", assignedTo: "w1" });
    await service.createTask({ title: "Second for w1", createdBy: "lead", assignedTo: "w1" });
    await service.createTask({ title: "One for w2", createdBy: "lead", assignedTo: "w2" });

    const { adapter, peakPerSession, turnsPerSession } = await countingProvider(200);
    const orchestrator = new TeamOrchestrator({
      service,
      runtime: { adapterFor: () => adapter },
      logger: nullLogger,
      turnTimeoutMs: 15_000,
    });
    await orchestrator.run();
    await orchestrator.dispose();

    const w1Session = `${service.run.id}:w1`;
    // Both of w1's tasks got a turn …
    expect(turnsPerSession.get(w1Session) ?? 0).toBeGreaterThanOrEqual(2);
    // … but never at the same time, while w2 still worked alongside.
    for (const [session, peak] of peakPerSession) {
      expect(peak, session).toBe(1);
    }
    expect(turnsPerSession.get(`${service.run.id}:w2`) ?? 0).toBeGreaterThanOrEqual(1);
  }, 30_000);

  it("keeps a note to a busy lead for after its turn instead of a second lead turn", async () => {
    const team = teamOf([agent("lead"), agent("w1")], "lead");
    const service = new TeamService({
      team,
      snapshot: snapshotOf(team),
      store: new InMemoryTeamRunStore(),
      logger: nullLogger,
      emit: () => {},
    });
    await service.start();
    // The lead is itself a member of the first batch.
    await service.createTask({ title: "Lead works too", createdBy: "lead", assignedTo: "lead" });
    await service.createTask({ title: "Worker task", createdBy: "lead", assignedTo: "w1" });

    const { adapter, peakPerSession } = await countingProvider(500);
    const orchestrator = new TeamOrchestrator({
      service,
      runtime: { adapterFor: () => adapter },
      logger: nullLogger,
      turnTimeoutMs: 15_000,
    });
    const running = orchestrator.run();
    // The note arrives while the lead is inside its own task turn.
    await new Promise((resolve) => setTimeout(resolve, 150));
    await service.sendMessage({
      from: "user",
      to: "lead",
      type: "request",
      content: "A note while you work",
    });
    orchestrator.notifyLeadMessage();
    await running;
    await orchestrator.dispose();

    expect(peakPerSession.get(`${service.run.id}:lead`)).toBe(1);
    // The note was still read — on the lead's next turn.
    expect(service.peekUnread("lead", { from: "user" })).toHaveLength(0);
  }, 30_000);
});
