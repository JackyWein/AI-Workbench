import { beforeEach, describe, expect, it } from "vitest";
import { MockProviderAdapter } from "@ai-workbench/provider-mock";
import type { AIProviderAdapter } from "@ai-workbench/provider-base";
import type {
  AgentDefinition,
  TeamDefinition,
  TeamEvent,
  TeamRunSnapshot,
} from "@ai-workbench/shared";
import { InMemoryTeamRunStore } from "../store.js";
import { TeamLimitError, TeamRuleError, TeamService } from "../service.js";
import { TeamOrchestrator } from "../orchestrator.js";
import { parseTeamActions } from "../protocol.js";
import { hasStalled, wouldCycle } from "../task-graph.js";
import { wouldPingPong } from "../limits.js";
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

function makeTeam(agents: AgentDefinition[], leadAgentId: string | null): TeamDefinition {
  const now = new Date();
  return {
    id: newTeamId(),
    name: "Checks",
    workspaceId: "ws_1",
    leadAgentId,
    agents,
    settings: {
      instructions: "",
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
    },
    createdAt: now,
    updatedAt: now,
  };
}

function makeSnapshot(team: TeamDefinition, goal: string): TeamRunSnapshot {
  const now = new Date();
  return {
    run: {
      id: newRunId(),
      teamId: team.id,
      workspaceId: team.workspaceId,
      goal,
      status: "pending",
      stopReason: null,
      outcome: null,
      sharedState: { goal, summary: "", currentPlan: null, importantContext: [] },
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
  };
}

interface Harness {
  service: TeamService;
  store: InMemoryTeamRunStore;
  events: TeamEvent[];
  team: TeamDefinition;
}

function boot(agents: AgentDefinition[], goal = "Ship the thing"): Harness {
  const team = makeTeam(agents, agents[0]?.id ?? null);
  const store = new InMemoryTeamRunStore();
  const events: TeamEvent[] = [];
  const service = new TeamService({
    team,
    snapshot: makeSnapshot(team, goal),
    store,
    logger: nullLogger,
    emit: (event) => events.push(event),
  });
  return { service, store, events, team };
}

describe("task graph", () => {
  it("holds a task until its dependencies complete", async () => {
    const { service } = boot([agent("a", "A")]);
    const first = await service.createTask({ title: "First", createdBy: "a" });
    const second = await service.createTask({
      title: "Second",
      createdBy: "a",
      dependencies: [first.id],
    });

    expect(second.status).toBe("blocked");
    expect(service.view().runnable.map((task) => task.id)).toEqual([first.id]);

    await service.completeTask(first.id, "done");
    expect(service.getTask(second.id)?.status).toBe("ready");
  });

  it("refuses a dependency that would close a cycle", async () => {
    const { service } = boot([agent("a", "A")]);
    const first = await service.createTask({ title: "First", createdBy: "a" });
    const byId = new Map([[first.id, { ...first, dependencies: ["x"] }]]);
    expect(wouldCycle("x", [first.id], byId)).toBe(true);
  });

  it("orders runnable work by priority, then by age", async () => {
    const { service } = boot([agent("a", "A")]);
    await service.createTask({ title: "Low", createdBy: "a" });
    await service.createTask({ title: "High", createdBy: "a", priority: 5 });
    expect(service.view().runnable.map((task) => task.title)).toEqual(["High", "Low"]);
  });

  it("sees a stall when nothing can ever run", async () => {
    const { service } = boot([agent("a", "A")]);
    const first = await service.createTask({ title: "First", createdBy: "a" });
    await service.createTask({
      title: "Second",
      createdBy: "a",
      dependencies: [first.id],
    });
    await service.failTask(first.id, "no");
    expect(hasStalled(service.view())).toBe(true);
  });
});

describe("team rules and limits", () => {
  it("refuses a task for an agent that is not on the team", async () => {
    const { service } = boot([agent("a", "A")]);
    await expect(
      service.createTask({ title: "x", createdBy: "a", assignedTo: "nobody" }),
    ).rejects.toBeInstanceOf(TeamRuleError);
  });

  it("stops delegation once the limit is reached", async () => {
    const { service, team } = boot([agent("a", "A"), agent("b", "B"), agent("c", "C")]);
    team.settings.limits.maxDelegationsPerTask = 1;
    const task = await service.createTask({ title: "x", createdBy: "a" });
    await service.delegateTask(task.id, "b", "a");
    await expect(service.delegateTask(task.id, "c", "b")).rejects.toBeInstanceOf(
      TeamLimitError,
    );
  });

  it("stops two agents passing the same task back and forth", () => {
    expect(wouldPingPong(["a", "b", "a"], "a")).toBe(true);
    expect(wouldPingPong(["a", "b"], "a")).toBe(false);
  });

  it("refuses more tasks than the run allows", async () => {
    const { service, team } = boot([agent("a", "A")]);
    team.settings.limits.maxTasks = 1;
    // The run carries its own copy of the limits, which is what is enforced.
    Object.assign(service.run.limits, { maxTasks: 1 });
    await service.createTask({ title: "one", createdBy: "a" });
    await expect(
      service.createTask({ title: "two", createdBy: "a" }),
    ).rejects.toBeInstanceOf(TeamLimitError);
  });
});

describe("mailbox, decisions and artifacts", () => {
  it("delivers a message once and remembers it was read", async () => {
    const { service } = boot([agent("a", "A"), agent("b", "B")]);
    await service.sendMessage({ from: "a", to: "b", type: "info", content: "hello" });

    const first = await service.getMessages("b", { unreadOnly: true });
    expect(first.map((message) => message.content)).toEqual(["hello"]);
    expect(await service.getMessages("b", { unreadOnly: true })).toHaveLength(0);
  });

  it("delivers a broadcast to everyone but its sender", async () => {
    const { service } = boot([agent("a", "A"), agent("b", "B")]);
    await service.sendMessage({ from: "a", to: "*", type: "info", content: "all" });
    expect(await service.getMessages("b")).toHaveLength(1);
    expect(await service.getMessages("a")).toHaveLength(0);
  });

  it("keeps decisions and artifacts and shows them in the shared state", async () => {
    const { service } = boot([agent("a", "A")]);
    await service.recordDecision({
      author: "a",
      title: "Use SQLite",
      decision: "It is embedded and needs no server",
    });
    await service.publishArtifact({ name: "notes.md", type: "doc", createdBy: "a" });

    const state = service.getState();
    expect(state.decisions[0]).toContain("Use SQLite");
    expect(state.artifacts[0]).toContain("notes.md");
  });
});

describe("the action protocol", () => {
  it("reads actions out of an answer and reports what it cannot use", () => {
    const answer = [
      "Some reasoning.",
      '```team\n{"action":"create_task","title":"Do it"}\n```',
      "```team\nnot json\n```",
      '```team\n{"action":"nonsense"}\n```',
    ].join("\n");

    const { actions, rejected } = parseTeamActions(answer);
    expect(actions).toEqual([{ action: "create_task", title: "Do it" }]);
    expect(rejected).toHaveLength(2);
  });

  it("accepts several actions in one block", () => {
    const answer =
      '```team\n[{"action":"complete_task","taskId":"t1","result":"ok"},' +
      '{"action":"finish_goal","outcome":"done"}]\n```';
    expect(parseTeamActions(answer).actions).toHaveLength(2);
  });
});

describe("autonomous collaboration", () => {
  let adapter: AIProviderAdapter;

  beforeEach(async () => {
    adapter = new MockProviderAdapter({ chunkDelayMs: 0, startupDelayMs: 0 });
    await adapter.initialize({
      config: { id: "mock", adapterId: "mock", transport: "in-process", authType: "none" },
      logger: nullLogger,
      stateDirectory: "/tmp",
    });
  });

  it("carries a goal from the lead through two workers and back", async () => {
    const { service, events } = boot(
      [agent("lead", "Lead"), agent("worker-1", "Worker One"), agent("worker-2", "Worker Two")],
      "Build a small feature",
    );
    const orchestrator = new TeamOrchestrator({
      service,
      runtime: { adapterFor: () => adapter },
      logger: nullLogger,
      turnTimeoutMs: 15_000,
    });

    const run = await orchestrator.run();
    await orchestrator.dispose();

    // The lead broke the goal down rather than answering it itself.
    const tasks = service.listTasks();
    expect(tasks.length).toBeGreaterThanOrEqual(2);
    expect(tasks.every((task) => task.status === "completed")).toBe(true);

    // The work actually went to the other agents.
    const workers = new Set(tasks.map((task) => task.assignedTo));
    expect(workers.has("worker-1")).toBe(true);
    expect(workers.has("worker-2")).toBe(true);

    // Their results came back and the lead closed the goal.
    expect(tasks.every((task) => (task.result ?? "").length > 0)).toBe(true);
    expect(run.status).toBe("completed");
    expect(run.stopReason).toBe("goalFinished");
    expect(run.outcome).toContain("Build a small feature");

    // And it was all reported live.
    const types = events.map((event) => event.type);
    expect(types).toContain("TEAM_STARTED");
    expect(types).toContain("TASK_CREATED");
    expect(types).toContain("TASK_ASSIGNED");
    expect(types).toContain("TASK_COMPLETED");
    expect(types).toContain("ARTIFACT_PUBLISHED");
    expect(types).toContain("DECISION_RECORDED");
    expect(types).toContain("TEAM_FINISHED");
    expect(service.listArtifacts().length).toBeGreaterThanOrEqual(2);
  });

  it("stops when the run runs out of agent calls", async () => {
    const { service } = boot([agent("lead", "Lead"), agent("worker-1", "W1")]);
    Object.assign(service.run.limits, { maxAgentCalls: 1 });

    const orchestrator = new TeamOrchestrator({
      service,
      runtime: { adapterFor: () => adapter },
      logger: nullLogger,
      turnTimeoutMs: 15_000,
    });
    const run = await orchestrator.run();
    await orchestrator.dispose();

    expect(run.stopReason).toBe("limitReached");
    expect(run.agentCalls).toBeLessThanOrEqual(1);
  });

  it("fails a task whose provider is gone, without taking the run with it", async () => {
    const { service } = boot([agent("lead", "Lead"), agent("worker-1", "W1")]);
    const orchestrator = new TeamOrchestrator({
      service,
      runtime: {
        adapterFor: (definition) => (definition.id === "lead" ? adapter : null),
      },
      logger: nullLogger,
      turnTimeoutMs: 15_000,
    });

    const run = await orchestrator.run();
    await orchestrator.dispose();

    expect(run.status).not.toBe("running");
    const failed = service.listTasks({ status: "failed" });
    expect(failed.length).toBeGreaterThan(0);
    expect(failed[0]?.error).toContain("not available");
  });

  it("restores a run from its store and continues", async () => {
    const { service, store, team } = boot(
      [agent("lead", "Lead"), agent("worker-1", "W1")],
      "Survive a restart",
    );
    await service.start();
    const created = await service.createTask({
      title: "Left over",
      createdBy: "lead",
      assignedTo: "worker-1",
    });

    // A second service over the same store is what a restart looks like.
    const restored = await store.loadSnapshot(service.run.id);
    expect(restored).not.toBeNull();

    const events: TeamEvent[] = [];
    const resumed = new TeamService({
      team,
      snapshot: restored!,
      store,
      logger: nullLogger,
      emit: (event) => events.push(event),
    });
    expect(resumed.getGoal()).toBe("Survive a restart");
    expect(resumed.getTask(created.id)?.title).toBe("Left over");

    const orchestrator = new TeamOrchestrator({
      service: resumed,
      runtime: { adapterFor: () => adapter },
      logger: nullLogger,
      turnTimeoutMs: 15_000,
    });
    const run = await orchestrator.run();
    await orchestrator.dispose();

    expect(resumed.getTask(created.id)?.status).toBe("completed");
    expect(run.status).toBe("completed");
  });
});
