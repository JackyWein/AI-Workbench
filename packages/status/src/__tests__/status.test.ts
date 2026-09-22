import { describe, expect, it } from "vitest";
import type { AggregatedUsage, TeamRunSnapshot } from "@ai-workbench/shared";
import { ISLAND_PRIORITY } from "@ai-workbench/shared";
import { StatusAttentionService } from "../attention-service.js";
import { teamProgressWidget } from "../widgets.js";

const nullLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => nullLogger,
};

const NOW = new Date("2026-01-01T12:00:00Z");

function boot(preferences: Record<string, unknown> = {}): StatusAttentionService {
  return new StatusAttentionService({
    logger: nullLogger,
    preferences: { enabled: true, ...preferences },
    now: () => NOW,
  });
}

function runWith(tasks: Array<{ status: string; title?: string; assignedTo?: string }>): TeamRunSnapshot {
  return {
    run: {
      id: "run_1",
      teamId: "team_1",
      workspaceId: "ws",
      goal: "Ship the feature",
      status: "running",
      stopReason: null,
      outcome: null,
      sharedState: { goal: "Ship the feature", summary: "", currentPlan: null, importantContext: [] },
      limits: {
        maxAgentCalls: 30,
        maxTasks: 50,
        maxTaskDepth: 8,
        maxRuntimeMinutes: 60,
        maxFailures: 10,
        maxConcurrentAgents: 3,
        maxMessages: 200,
        maxDelegationsPerTask: 4,
      },
      agentCalls: 3,
      failures: 0,
      messageCount: 0,
      createdAt: NOW,
      startedAt: NOW,
      finishedAt: null,
    },
    tasks: tasks.map((task, index) => ({
      id: `task_${index}`,
      runId: "run_1",
      title: task.title ?? `Task ${index}`,
      description: "",
      status: task.status as TeamRunSnapshot["tasks"][number]["status"],
      createdBy: "lead",
      assignedTo: task.assignedTo ?? "worker",
      parentTaskId: null,
      dependencies: [],
      priority: 0,
      depth: 0,
      delegations: 0,
      result: null,
      artifacts: [],
      error: null,
      createdAt: NOW,
      startedAt: null,
      completedAt: null,
    })),
    messages: [],
    decisions: [],
    artifacts: [],
  };
}

const usageWith = (used: number): AggregatedUsage => ({
  snapshots: [
    {
      providerId: "mock",
      state: "available",
      source: "provider",
      limits: [{ id: "weekly", label: "Weekly", unit: "percent", used }],
      updatedAt: NOW,
    },
  ],
  updatedAt: NOW,
});

describe("the priority engine", () => {
  it("is idle and says so when there is nothing to report", () => {
    const service = boot();
    expect(service.state.current.widget).toBe("idle");
    expect(service.state.current.title).toContain("Idle");
    expect(service.state.expanded).toBe(false);
  });

  it("puts an action a person has to take above everything else", () => {
    const service = boot();
    const state = service.update({
      usage: usageWith(40),
      runs: [runWith([{ status: "running" }])],
      attention: [
        {
          key: "confirm-1",
          title: "Codex needs your attention",
          detail: "Terminal action requires confirmation",
          sessionId: "ses_1",
          at: NOW,
        },
      ],
      now: NOW,
    });

    expect(state.current.widget).toBe("needsAttention");
    expect(state.current.priority).toBe(ISLAND_PRIORITY.userActionRequired);
    // And it offers a way into the right place in the application (spec §98).
    expect(state.current.action?.target).toEqual({ view: "chat", sessionId: "ses_1" });
  });

  it("ranks a failure above progress, and progress above usage", () => {
    const service = boot();
    const state = service.update({
      usage: usageWith(40),
      runs: [runWith([{ status: "running" }])],
      errors: [{ key: "err-1", title: "MCP server failed", detail: "ENOENT", at: NOW }],
      now: NOW,
    });

    expect(state.entries.map((entry) => entry.widget)).toEqual([
      "errors",
      "teamProgress",
      "activeAgents",
      "providerUsage",
    ]);
    expect(state.current.widget).toBe("errors");
  });

  it("lets an important event take the island and then settles back", () => {
    let clock = NOW;
    const service = new StatusAttentionService({
      logger: nullLogger,
      preferences: { enabled: true },
      expandMs: 5_000,
      now: () => clock,
    });

    service.update({ usage: usageWith(40), now: clock });
    expect(service.state.current.widget).toBe("providerUsage");

    const completed = service.update({
      completed: [
        { key: "run_1:done", title: "Project completed", detail: "11 of 11 tasks", at: clock },
      ],
      now: clock,
    });
    expect(completed.current.widget).toBe("completedWork");
    expect(completed.expanded).toBe(true);

    // After its moment the island is compact again (spec §97), still showing
    // the completion because that is still the most important thing.
    clock = new Date(NOW.getTime() + 6_000);
    const settled = service.update({ now: clock });
    expect(settled.expanded).toBe(false);
    expect(settled.current.widget).toBe("completedWork");

    // And once the news is stale it goes back to the quiet widget.
    clock = new Date(NOW.getTime() + 10 * 60_000);
    const later = service.update({ now: clock });
    expect(later.current.widget).toBe("providerUsage");
  });

  it("does not expand twice for the same news", () => {
    let clock = NOW;
    const service = new StatusAttentionService({
      logger: nullLogger,
      preferences: { enabled: true },
      expandMs: 1_000,
      now: () => clock,
    });
    const entry = { key: "run_1:done", title: "Done", detail: "", at: NOW };

    expect(service.update({ completed: [entry], now: clock }).expanded).toBe(true);
    clock = new Date(NOW.getTime() + 2_000);
    expect(service.update({ completed: [entry], now: clock }).expanded).toBe(false);
  });

  it("holds a pinned widget, and says so when it has nothing", () => {
    const service = boot();
    service.update({ usage: usageWith(40), runs: [runWith([{ status: "running" }])], now: NOW });

    expect(service.pin("providerUsage").current.widget).toBe("providerUsage");
    // Pinned to something with nothing to say is stated, not quietly replaced.
    expect(service.pin("connectionHealth").current.title).toContain("nothing to report");
    expect(service.pin(null).current.widget).toBe("teamProgress");
  });

  it("obeys a pin at once, even while something is holding the island", () => {
    const service = boot();
    service.update({
      usage: usageWith(40),
      runs: [runWith([{ status: "running" }])],
      attention: [
        { key: "ask-1", title: "Needs you", detail: "", runId: "run_1", at: NOW },
      ],
      now: NOW,
    });
    // The attention is new, so it is holding the island.
    expect(service.state.current.widget).toBe("needsAttention");

    // Pinning is an explicit choice and wins immediately (spec §100).
    expect(service.pin("providerUsage").current.widget).toBe("providerUsage");
    // And it stays pinned on the next refresh rather than snapping back.
    expect(service.update({ now: NOW }).current.widget).toBe("providerUsage");
  });

  it("cycles through the widgets that have something to say", () => {
    const service = boot();
    service.update({ usage: usageWith(40), runs: [runWith([{ status: "running" }])], now: NOW });

    const first = service.state.current.widget;
    const seen = [first];
    for (let step = 0; step < service.state.entries.length - 1; step += 1) {
      seen.push(service.cycle().current.widget);
    }
    expect(new Set(seen).size).toBe(service.state.entries.length);
    // One more step comes back round to where it started.
    expect(service.cycle().current.widget).toBe(first);
  });

  it("shows only the widgets the user enabled", () => {
    const service = boot({ enabledWidgets: ["providerUsage"] });
    const state = service.update({
      usage: usageWith(40),
      errors: [{ key: "err", title: "Broken", detail: "", at: NOW }],
      now: NOW,
    });
    expect(state.entries.map((entry) => entry.widget)).toEqual(["providerUsage"]);
  });
});

describe("honest progress", () => {
  it("counts tasks instead of estimating", () => {
    const entry = teamProgressWidget.build({
      usage: null,
      runs: [
        runWith([
          { status: "completed" },
          { status: "completed" },
          { status: "running" },
          { status: "blocked" },
        ]),
      ],
      busySessions: [],
      attention: [],
      errors: [],
      brokenConnections: [],
      completed: [],
      now: NOW,
    });

    expect(entry?.progress).toEqual({ completed: 2, total: 4 });
    expect(entry?.detail).toBe("2 of 4 tasks · 50%");
  });

  it("gives no percentage when there are no tasks to count", () => {
    const entry = teamProgressWidget.build({
      usage: null,
      runs: [runWith([])],
      busySessions: [],
      attention: [],
      errors: [],
      brokenConnections: [],
      completed: [],
      now: NOW,
    });

    expect(entry?.progress).toBeNull();
    expect(entry?.detail).toBe("Planning");
  });

  it("describes a solo session by its state, not a number", () => {
    const service = boot();
    const state = service.update({
      busySessions: [{ sessionId: "ses_1", name: "Refactor", status: "implementing" }],
      now: NOW,
    });

    expect(state.current.widget).toBe("activeAgents");
    expect(state.current.detail).toBe("implementing");
    expect(state.current.progress).toBeNull();
    expect(state.current.title).not.toMatch(/\d+%/);
  });

  it("reports no usage at all rather than a made-up one", () => {
    const service = boot();
    const state = service.update({
      usage: {
        snapshots: [
          {
            providerId: "mock",
            state: "available",
            source: "provider",
            limits: [{ id: "weekly", label: "Weekly", unit: "tokens" }],
            updatedAt: NOW,
          },
        ],
        updatedAt: NOW,
      },
      now: NOW,
    });

    expect(state.entries.some((entry) => entry.widget === "providerUsage")).toBe(false);
  });
});
