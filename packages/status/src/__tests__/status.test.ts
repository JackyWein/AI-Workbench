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

  it("cycles to the next widget while an entry is holding the island", () => {
    // The state the application is actually in when this is used: an unread
    // question is holding the island, and several other widgets have
    // something to say behind it.
    const service = boot();
    const state = service.update({
      usage: usageWith(40),
      busySessions: [{ sessionId: "s1", name: "One", status: "answering" }],
      attention: [{ key: "ask-1", title: "Needs you", detail: "", at: NOW }],
      brokenConnections: [{ key: "mcp:x", title: "x is not connected", detail: "" }],
      completed: [{ key: "run_1:done", title: "Finished", detail: "", at: NOW }],
      now: NOW,
    });
    expect(state.entries.map((entry) => entry.widget)).toEqual([
      "needsAttention",
      "connectionHealth",
      "completedWork",
      "activeAgents",
      "providerUsage",
    ]);
    expect(state.current.widget).toBe("needsAttention");

    // One step lands on the next widget and pins it, holding entry or not.
    const stepped = service.cycle(1);
    expect(stepped.preferences.pinnedWidget).toBe("connectionHealth");
    expect(stepped.current.widget).toBe("connectionHealth");

    // And it is still there after the next refresh of the sources.
    expect(service.update({ now: NOW }).current.widget).toBe("connectionHealth");
  });

  it("steps from where the island settles, not from the news holding it", () => {
    // Each refresh gives one unseen piece of news its moment, so after three
    // the island is held by the completion — which is neither the most
    // important entry nor the one next in line.
    const service = boot();
    const sources = {
      usage: usageWith(40),
      attention: [{ key: "ask-1", title: "Needs you", detail: "", at: NOW }],
      brokenConnections: [{ key: "mcp:x", title: "x is not connected", detail: "" }],
      completed: [{ key: "run_1:done", title: "Finished", detail: "", at: NOW }],
      now: NOW,
    };
    const state = service.update(sources);
    expect(state.entries.map((entry) => entry.widget)).toEqual([
      "needsAttention",
      "connectionHealth",
      "completedWork",
      "providerUsage",
    ]);
    service.update({ now: NOW });
    expect(service.update({ now: NOW }).current.widget).toBe("completedWork");

    // Touching the island lets that go, so one step lands on the widget after
    // the one the island settles on — not on the one after the announcement.
    const stepped = service.cycle(1);
    expect(stepped.current.widget).toBe("connectionHealth");
    expect(stepped.preferences.pinnedWidget).toBe("connectionHealth");
  });

  it("goes back to the most important entry when asked for automatic", () => {
    const service = boot();
    const sources = {
      usage: usageWith(40),
      attention: [{ key: "ask-1", title: "Needs you", detail: "", at: NOW }],
      completed: [{ key: "run_1:done", title: "Finished", detail: "", at: NOW }],
      now: NOW,
    };
    service.update(sources);
    expect(service.update({ now: NOW }).current.widget).toBe("completedWork");

    // Asking for automatic is an explicit choice, so the announcement stops
    // holding the island instead of outlasting the request (spec §100).
    const automatic = service.pin(null);
    expect(automatic.preferences.pinnedWidget).toBeNull();
    expect(automatic.current.widget).toBe("needsAttention");
    expect(service.update({ now: NOW }).current.widget).toBe("needsAttention");
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
      providers: [],
      sessions: [],
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
      providers: [],
      sessions: [],
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

describe("the island's agent rows and quiet picture", () => {
  it("lists every busy agent with its own clock, mark and target", () => {
    const service = boot();
    const started = new Date(NOW.getTime() - 252_000);
    const state = service.update({
      busySessions: [
        {
          key: "tile:a",
          sessionId: "a",
          name: "Claude Code",
          status: "working",
          startedAt: started,
          icon: "claude-code",
          detail: "34.9k tokens · Haiku 4.5",
          target: { view: "chat" },
        },
        { key: "tile:b", sessionId: "b", name: "Codex", status: "working", icon: "codex" },
      ],
      now: NOW,
    });
    const entry = state.entries.find((candidate) => candidate.widget === "activeAgents");
    expect(entry?.agents.map((row) => row.key)).toEqual(["tile:a", "tile:b"]);
    expect(entry?.agents[0]).toMatchObject({
      title: "Claude Code",
      detail: "34.9k tokens · Haiku 4.5",
      icon: "claude-code",
      startedAt: started,
    });
    // No start known means no clock, rather than one that restarts.
    expect(entry?.agents[1]?.startedAt).toBeNull();
    expect(entry?.agents[1]?.target).toEqual({ view: "chat", sessionId: "b" });
  });

  it("names usage rows by the provider and says when a tool reports no limit", () => {
    const service = boot();
    const state = service.update({
      usage: {
        snapshots: [
          ...usageWith(40).snapshots,
          { providerId: "other", state: "available", source: "provider", limits: [], updatedAt: NOW },
        ],
        updatedAt: NOW,
      },
      providers: [
        { id: "mock", name: "Mock Provider", icon: null },
        { id: "other", name: "Other", icon: "opencode" },
      ],
      now: NOW,
    });
    const rows = state.entries.find((entry) => entry.widget === "providerUsage")?.usage ?? [];
    expect(rows).toEqual([
      { providerId: "mock", name: "Mock Provider", icon: null, window: "Weekly", percentLeft: 60, note: "" },
      { providerId: "other", name: "Other", icon: "opencode", window: "", percentLeft: null, note: "No limit reported" },
    ]);
  });

  it("counts resting sessions from the last day and names the longest idle", () => {
    const minutes = (value: number): Date => new Date(NOW.getTime() - value * 60_000);
    const state = boot().update({
      sessions: [
        { name: "Codex", icon: "codex", lastActiveAt: minutes(42), busy: false },
        { name: "Claude", icon: "claude-code", lastActiveAt: minutes(5), busy: false },
        { name: "Busy", icon: null, lastActiveAt: minutes(90), busy: true },
        { name: "Old", icon: null, lastActiveAt: minutes(60 * 48), busy: false },
      ],
      now: NOW,
    });
    expect(state.sessions.recent).toBe(2);
    expect(state.sessions.longestIdle).toEqual({ name: "Codex", icon: "codex", at: minutes(42) });
    expect(state.sessions.last?.name).toBe("Claude");
  });
});
