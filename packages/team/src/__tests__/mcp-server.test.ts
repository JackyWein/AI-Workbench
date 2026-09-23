import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { AgentDefinition, TeamDefinition, TeamEvent } from "@ai-workbench/shared";
import { createTeamMcpServer } from "../mcp-server.js";
import { TeamService } from "../service.js";
import { InMemoryTeamRunStore } from "../store.js";
import { newRunId, newTeamId } from "../ids.js";

const nullLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => nullLogger,
};

const agent = (id: string, displayName: string): AgentDefinition => ({
  id,
  displayName,
  providerId: "mock",
  role: "",
  workingDirectory: "/tmp",
  skills: [],
  plugins: [],
  mcpServers: [],
  settings: {},
});

const LIMITS = {
  maxAgentCalls: 30,
  maxTasks: 50,
  maxTaskDepth: 8,
  maxRuntimeMinutes: 60,
  maxFailures: 10,
  maxConcurrentAgents: 3,
  maxMessages: 200,
  maxDelegationsPerTask: 4,
  agentTurnSilenceSeconds: 600,
};

function bootService(): { service: TeamService; team: TeamDefinition; events: TeamEvent[] } {
  const now = new Date();
  const team: TeamDefinition = {
    id: newTeamId(),
    name: "Checks",
    workspaceId: "ws",
    leadAgentId: "lead",
    agents: [agent("lead", "Lead"), agent("worker", "Worker")],
    settings: {
      instructions: "",
      allowOutsideWorkspace: false,
      workingDirectory: null,
      limits: LIMITS,
    },
    createdAt: now,
    updatedAt: now,
  };
  const goal = "Make the MCP surface real";
  const events: TeamEvent[] = [];
  const service = new TeamService({
    team,
    store: new InMemoryTeamRunStore(),
    logger: nullLogger,
    emit: (event) => events.push(event),
    snapshot: {
      run: {
        id: newRunId(),
        teamId: team.id,
        workspaceId: "ws",
        goal,
        status: "running",
        stopReason: null,
        outcome: null,
        sharedState: { goal, summary: "", currentPlan: null, importantContext: [] },
        limits: LIMITS,
        agentCalls: 0,
        failures: 0,
        messageCount: 0,
        createdAt: now,
        startedAt: now,
        finishedAt: null,
      },
      tasks: [],
      messages: [],
      decisions: [],
      artifacts: [],
    },
  });
  return { service, team, events };
}

/** A real MCP client against the real server, over a paired transport. */
async function connect(service: TeamService, agentId: string): Promise<Client> {
  const server = createTeamMcpServer({ service, agentId });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "check", version: "1.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

function textOf(result: unknown): string {
  const content = (result as { content?: Array<{ text?: string }> }).content ?? [];
  return content.map((entry) => entry.text ?? "").join("\n");
}

describe("the team MCP server", () => {
  let service: TeamService;
  let lead: Client;
  let worker: Client;

  beforeEach(async () => {
    ({ service } = bootService());
    lead = await connect(service, "lead");
    worker = await connect(service, "worker");
  });

  afterEach(async () => {
    await lead.close();
    await worker.close();
  });

  it("offers every tool the specification requires", async () => {
    const { tools } = await lead.listTools();
    const names = tools.map((tool) => tool.name).sort();
    expect(names).toEqual(
      [
        "team_claim_task",
        "team_complete_task",
        "team_create_task",
        "team_delegate_task",
        "team_fail_task",
        "team_finish_goal",
        "team_get_agent",
        "team_get_artifact",
        "team_get_decisions",
        "team_get_goal",
        "team_get_messages",
        "team_get_state",
        "team_get_task",
        "team_list_agents",
        "team_list_artifacts",
        "team_list_tasks",
        "team_publish_artifact",
        "team_record_decision",
        "team_request_help",
        "team_send_message",
        "team_update_task",
      ].sort(),
    );
  });

  it("lets an agent read the goal and the shared state", async () => {
    expect(textOf(await lead.callTool({ name: "team_get_goal", arguments: {} }))).toContain(
      "Make the MCP surface real",
    );
    const state = textOf(await lead.callTool({ name: "team_get_state", arguments: {} }));
    expect(state).toContain("worker");
  });

  it("carries a task from the lead to the worker and back", async () => {
    const created = textOf(
      await lead.callTool({
        name: "team_create_task",
        arguments: { title: "Write the adapter", assignTo: "worker" },
      }),
    );
    const taskId = (JSON.parse(created) as { id: string }).id;

    // The worker sees it as its own and finishes it.
    const mine = JSON.parse(
      textOf(
        await worker.callTool({
          name: "team_list_tasks",
          arguments: { assignedTo: "worker" },
        }),
      ),
    ) as Array<{ id: string }>;
    expect(mine.map((task) => task.id)).toEqual([taskId]);

    await worker.callTool({ name: "team_claim_task", arguments: { taskId } });
    await worker.callTool({
      name: "team_publish_artifact",
      arguments: { name: "adapter.ts", type: "code", content: "export {}", taskId },
    });
    await worker.callTool({
      name: "team_complete_task",
      arguments: { taskId, result: "Adapter written" },
    });

    expect(service.getTask(taskId)?.status).toBe("completed");
    expect(service.getTask(taskId)?.result).toBe("Adapter written");
    expect(service.listArtifacts()).toHaveLength(1);
  });

  it("delivers a message between two agents", async () => {
    await lead.callTool({
      name: "team_send_message",
      arguments: { to: "worker", type: "request", content: "Please review" },
    });
    const inbox = textOf(
      await worker.callTool({ name: "team_get_messages", arguments: { unreadOnly: true } }),
    );
    expect(inbox).toContain("Please review");
  });

  it("acts as the connected agent, never as another", async () => {
    const created = textOf(
      await worker.callTool({ name: "team_create_task", arguments: { title: "Mine" } }),
    );
    expect((JSON.parse(created) as { createdBy: string }).createdBy).toBe("worker");
  });

  it("answers a refusal instead of failing the call", async () => {
    const result = await worker.callTool({
      name: "team_finish_goal",
      arguments: { outcome: "I decided we are done" },
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("Only the lead agent");
    expect(service.run.status).toBe("running");
  });

  it("explains a limit rather than just refusing", async () => {
    Object.assign(service.run.limits, { maxTasks: 0 });
    const result = await lead.callTool({
      name: "team_create_task",
      arguments: { title: "One too many" },
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("limit maxTasks");
  });

  it("lets the lead finish the goal", async () => {
    await lead.callTool({
      name: "team_finish_goal",
      arguments: { outcome: "The surface is real" },
    });
    expect(service.run.status).toBe("completed");
    expect(service.run.outcome).toBe("The surface is real");
  });
});
