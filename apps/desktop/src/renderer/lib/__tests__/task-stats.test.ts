import { describe, expect, it } from "vitest";
import type {
  AggregatedUsage,
  ChatMessage,
  ProviderSummary,
  TeamRunSnapshot,
} from "@ai-workbench/shared";
import {
  remainingStatus,
  soloSessionStats,
  taskDurationMs,
  taskTokens,
  teamRunStats,
} from "../task-stats.js";

function assistantMessage(usage: ChatMessage["usage"]): ChatMessage {
  return {
    id: `m-${Math.random()}`,
    sessionId: "s",
    role: "assistant",
    content: "hi",
    status: "complete",
    providerId: "p",
    modelId: "m",
    toolCalls: [],
    attachments: [],
    usage,
    error: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

describe("soloSessionStats", () => {
  it("sums durations and tokens from reported usage", () => {
    const stats = soloSessionStats([
      assistantMessage({
        limits: [],
        inputTokens: 100,
        outputTokens: 50,
        cacheReadTokens: 10,
        durationMs: 2000,
      }),
      assistantMessage({
        limits: [],
        inputTokens: 20,
        outputTokens: 5,
        durationMs: 1000,
      }),
    ]);
    expect(stats.turns).toBe(2);
    expect(stats.durationMs).toBe(3000);
    expect(stats.tokens).toBe(185);
  });

  it("reports zero tokens as zero usage, not unknown (caller renders —)", () => {
    const stats = soloSessionStats([assistantMessage(null)]);
    expect(stats.turns).toBe(1);
    expect(stats.tokens).toBe(0);
    expect(stats.durationMs).toBe(0);
  });
});

describe("taskDurationMs", () => {
  it("reads finished tasks from timestamps", () => {
    const duration = taskDurationMs(
      {
        id: "t",
        runId: "r",
        title: "Task",
        description: "",
        status: "completed",
        createdBy: "lead",
        assignedTo: null,
        parentTaskId: null,
        dependencies: [],
        priority: 0,
        depth: 0,
        delegations: 0,
        result: null,
        artifacts: [],
        error: null,
        createdAt: new Date("2026-01-01T00:00:00Z"),
        startedAt: new Date("2026-01-01T00:00:00Z"),
        completedAt: new Date("2026-01-01T00:10:00Z"),
      },
      new Date("2026-01-01T01:00:00Z").getTime(),
    );
    expect(duration).toBe(600_000);
  });

  it("counts a running task up to now, unknown when never started", () => {
    const now = new Date("2026-01-01T00:05:00Z").getTime();
    const running = taskDurationMs(
      {
        id: "t",
        runId: "r",
        title: "Task",
        description: "",
        status: "running",
        createdBy: "lead",
        assignedTo: null,
        parentTaskId: null,
        dependencies: [],
        priority: 0,
        depth: 0,
        delegations: 0,
        result: null,
        artifacts: [],
        error: null,
        createdAt: new Date("2026-01-01T00:00:00Z"),
        startedAt: new Date("2026-01-01T00:00:00Z"),
        completedAt: null,
      },
      now,
    );
    expect(running).toBe(300_000);
    const pending = taskDurationMs(
      {
        id: "u",
        runId: "r",
        title: "Other",
        description: "",
        status: "ready",
        createdBy: "lead",
        assignedTo: null,
        parentTaskId: null,
        dependencies: [],
        priority: 0,
        depth: 0,
        delegations: 0,
        result: null,
        artifacts: [],
        error: null,
        createdAt: new Date("2026-01-01T00:00:00Z"),
        startedAt: null,
        completedAt: null,
      },
      now,
    );
    expect(pending).toBeNull();
  });
});

function snapshotWithTurns(
  turns: TeamRunSnapshot["turns"],
): TeamRunSnapshot {
  return {
    run: {
      id: "r",
      teamId: "t",
      workspaceId: "w",
      goal: "goal",
      status: "running",
      stopReason: null,
      outcome: null,
      sharedState: { goal: "", summary: "", currentPlan: null, importantContext: [] },
      limits: {
        maxAgentCalls: 30,
        maxTasks: 50,
        maxTaskDepth: 8,
        maxRuntimeMinutes: 240,
        maxFailures: 10,
        maxConcurrentAgents: 3,
        maxMessages: 200,
        maxDelegationsPerTask: 4,
        agentTurnSilenceSeconds: 900,
      },
      agentCalls: 1,
      failures: 0,
      messageCount: 0,
      createdAt: new Date("2026-01-01T00:00:00Z"),
      startedAt: new Date("2026-01-01T00:00:00Z"),
      finishedAt: null,
    },
    tasks: [],
    messages: [],
    decisions: [],
    artifacts: [],
    turns,
  };
}

describe("teamRunStats", () => {
  it("reports unknown tokens when no turn carries usage", () => {
    const stats = teamRunStats(
      snapshotWithTurns([
        {
          id: "turn-1",
          runId: "r",
          agentId: "a",
          taskId: null,
          status: "completed",
          output: "done",
          steps: [],
          error: null,
          startedAt: new Date("2026-01-01T00:00:00Z"),
          finishedAt: new Date("2026-01-01T00:01:00Z"),
        },
      ]),
      new Date("2026-01-01T00:10:00Z").getTime(),
    );
    expect(stats.tokens).toBeNull();
    expect(stats.runDurationMs).toBe(600_000);
  });

  it("sums tokens once turns carry reported usage", () => {
    const stats = teamRunStats(
      snapshotWithTurns([
        {
          id: "turn-1",
          runId: "r",
          agentId: "a",
          taskId: "task-1",
          status: "completed",
          output: "done",
          steps: [],
          error: null,
          startedAt: new Date("2026-01-01T00:00:00Z"),
          finishedAt: new Date("2026-01-01T00:01:00Z"),
          usage: { limits: [], inputTokens: 100, outputTokens: 25 },
        } as unknown as TeamRunSnapshot["turns"][number],
      ]),
      new Date("2026-01-01T00:10:00Z").getTime(),
    );
    expect(stats.tokens).toBe(125);
    expect(taskTokens(snapshotWithTurns([
      {
        id: "turn-1",
        runId: "r",
        agentId: "a",
        taskId: "task-1",
        status: "completed",
        output: "done",
        steps: [],
        error: null,
        startedAt: new Date("2026-01-01T00:00:00Z"),
        finishedAt: new Date("2026-01-01T00:01:00Z"),
        usage: { limits: [], inputTokens: 100, outputTokens: 25 },
      } as unknown as TeamRunSnapshot["turns"][number],
    ]), "task-1")).toBe(125);
  });
});

function provider(id: string, supportsUsage: boolean): ProviderSummary {
  return {
    metadata: {
      id,
      displayName: id,
      icon: id,
      transportTypes: ["cli"],
      installCommand: null,
      docsUrl: null,
    },
    installation: { state: "installed", version: "1", detail: null },
    auth: { state: "unknown", detail: "probe unavailable" },
    capabilities: {
      supported: supportsUsage ? ["usage", "chat"] : ["chat"],
      unsupported: [],
    },
    models: [],
    accounts: [],
  } as unknown as ProviderSummary;
}

describe("remainingStatus", () => {
  it("says unverified when no provider can report usage", () => {
    const status = remainingStatus({
      usage: null,
      providers: [provider("cli-a", false)],
      providerIds: ["cli-a"],
      now: Date.now(),
    });
    expect(status.kind).toBe("unverified");
  });

  it("says unknown when a capable provider reported nothing", () => {
    const status = remainingStatus({
      usage: null,
      providers: [provider("cli-a", true)],
      providerIds: ["cli-a"],
      now: Date.now(),
    });
    expect(status.kind).toBe("unknown");
  });

  it("reads the tightest reported limit, never inventing one", () => {
    const usage: AggregatedUsage = {
      updatedAt: new Date(),
      snapshots: [
        {
          providerId: "cli-a",
          state: "available",
          limits: [
            { id: "week", label: "Weekly", used: 80, total: 100, unit: "percent" },
          ],
          updatedAt: new Date(),
          source: "cli",
        },
      ],
    };
    const status = remainingStatus({
      usage,
      providers: [provider("cli-a", true)],
      providerIds: ["cli-a"],
      now: Date.now(),
    });
    expect(status.kind).toBe("ready");
    if (status.kind === "ready") {
      expect(status.percentUsed).toBe(80);
    }
  });
});
