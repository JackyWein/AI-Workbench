import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { McpServerConfig } from "@ai-workbench/shared";
import { z } from "zod";
import { EVERYONE, TeamLimitError, TeamRuleError, type TeamService } from "./service.js";

/**
 * `ai-workbench-team-mcp` — the agent-facing protocol (spec §42).
 *
 * It is not the orchestrator (spec §43): every tool is a thin call into the
 * `TeamService`, which is where the rules and the limits live. A provider that
 * speaks MCP reaches the team through here; one that does not uses the same
 * operations as action blocks, and both end in the same service.
 *
 * The server is scoped to one agent, so an agent cannot act as another: the id
 * comes from the connection, never from the arguments.
 */
export interface TeamMcpServerOptions {
  readonly service: TeamService;
  /** The agent this connection belongs to. */
  readonly agentId: string;
  readonly version?: string;
}

type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

function ok(value: unknown): ToolResult {
  return {
    content: [
      { type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) },
    ],
  };
}

function failed(error: unknown): ToolResult {
  // A refusal is an answer, not a transport failure: the agent has to be able
  // to read why and do something else.
  const message =
    error instanceof TeamLimitError
      ? `Refused (limit ${error.limit}): ${error.message}`
      : error instanceof TeamRuleError
        ? `Refused: ${error.message}`
        : error instanceof Error
          ? error.message
          : String(error);
  return { content: [{ type: "text", text: message }], isError: true };
}

async function attempt(run: () => Promise<unknown> | unknown): Promise<ToolResult> {
  try {
    return ok(await run());
  } catch (error) {
    return failed(error);
  }
}

export function createTeamMcpServer(options: TeamMcpServerOptions): McpServer {
  const { service, agentId } = options;
  const server = new McpServer({
    name: "ai-workbench-team-mcp",
    version: options.version ?? "1.0.0",
  });

  const taskId = z.string().min(1).describe("A task id from team_list_tasks");
  const agentArg = z.string().min(1).describe("An agent id from team_list_agents");

  server.tool("team_get_goal", "The goal this team is working on", {}, async () =>
    ok(service.getGoal()),
  );

  server.tool(
    "team_get_state",
    "The shared team state: plan, summary, tasks, decisions, artifacts and agents",
    {},
    async () => ok(service.getState()),
  );

  server.tool("team_list_agents", "Everyone on this team", {}, async () =>
    ok(service.listAgents()),
  );

  server.tool("team_get_agent", "One agent's definition", { agentId: agentArg }, async (args) =>
    ok(service.getAgent(args.agentId)),
  );

  server.tool(
    "team_list_tasks",
    "The task graph, optionally filtered",
    {
      status: z.string().optional(),
      assignedTo: z.string().optional(),
    },
    async (args) =>
      ok(
        service.listTasks({
          ...(args.status === undefined ? {} : { status: args.status }),
          ...(args.assignedTo === undefined ? {} : { assignedTo: args.assignedTo }),
        }),
      ),
  );

  server.tool("team_get_task", "One task", { taskId }, async (args) =>
    ok(service.getTask(args.taskId)),
  );

  server.tool(
    "team_create_task",
    "Add a task to the graph, optionally assigned and optionally depending on others",
    {
      title: z.string().min(1).max(300),
      description: z.string().max(20_000).optional(),
      assignTo: z.string().optional(),
      dependsOn: z.array(z.string()).optional(),
      parentTaskId: z.string().optional(),
      priority: z.number().int().optional(),
    },
    async (args) =>
      attempt(() =>
        service.createTask({
          title: args.title,
          ...(args.description === undefined ? {} : { description: args.description }),
          createdBy: agentId,
          ...(args.assignTo === undefined ? {} : { assignedTo: args.assignTo }),
          ...(args.parentTaskId === undefined ? {} : { parentTaskId: args.parentTaskId }),
          ...(args.dependsOn === undefined ? {} : { dependencies: args.dependsOn }),
          ...(args.priority === undefined ? {} : { priority: args.priority }),
        }),
      ),
  );

  server.tool("team_claim_task", "Take an unassigned task", { taskId }, async (args) =>
    attempt(() => service.claimTask(args.taskId, agentId)),
  );

  server.tool(
    "team_delegate_task",
    "Hand a task to another agent",
    { taskId, to: agentArg },
    async (args) => attempt(() => service.delegateTask(args.taskId, args.to, agentId)),
  );

  server.tool(
    "team_update_task",
    "Change a task's description, priority or interim result",
    {
      taskId,
      description: z.string().max(20_000).optional(),
      priority: z.number().int().optional(),
      result: z.string().max(20_000).optional(),
    },
    async (args) =>
      attempt(() =>
        service.updateTask(args.taskId, {
          ...(args.description === undefined ? {} : { description: args.description }),
          ...(args.priority === undefined ? {} : { priority: args.priority }),
          ...(args.result === undefined ? {} : { result: args.result }),
        }),
      ),
  );

  server.tool(
    "team_complete_task",
    "Finish a task and report what it produced",
    {
      taskId,
      result: z.string().max(20_000),
      artifacts: z.array(z.string()).optional(),
    },
    async (args) =>
      attempt(() => service.completeTask(args.taskId, args.result, args.artifacts ?? [])),
  );

  server.tool(
    "team_fail_task",
    "Report that a task cannot be done, and why",
    { taskId, error: z.string().max(20_000) },
    async (args) => attempt(() => service.failTask(args.taskId, args.error)),
  );

  server.tool(
    "team_send_message",
    `Message a team mate, or "${EVERYONE}" for everyone`,
    {
      to: z.string().min(1),
      type: z.enum(["info", "question", "request", "result", "warning", "handoff"]),
      content: z.string().max(100_000),
      taskId: z.string().optional(),
    },
    async (args) =>
      attempt(() =>
        service.sendMessage({
          from: agentId,
          to: args.to,
          type: args.type,
          content: args.content,
          ...(args.taskId === undefined ? {} : { taskId: args.taskId }),
        }),
      ),
  );

  server.tool(
    "team_get_messages",
    "Your inbox. Reading marks messages read, so none arrives twice",
    { unreadOnly: z.boolean().optional() },
    async (args) =>
      attempt(() => service.getMessages(agentId, { unreadOnly: args.unreadOnly ?? true })),
  );

  server.tool(
    "team_request_help",
    "Ask the lead when you cannot continue",
    { question: z.string().min(1).max(20_000), taskId: z.string().optional() },
    async (args) =>
      attempt(() =>
        service.requestHelp({
          from: agentId,
          question: args.question,
          ...(args.taskId === undefined ? {} : { taskId: args.taskId }),
        }),
      ),
  );

  server.tool(
    "team_publish_artifact",
    "Publish something you produced, so the team can use it",
    {
      name: z.string().min(1).max(300),
      type: z.string().min(1).max(100),
      path: z.string().optional(),
      content: z.string().optional(),
      taskId: z.string().optional(),
    },
    async (args) =>
      attempt(() =>
        service.publishArtifact({
          name: args.name,
          type: args.type,
          createdBy: agentId,
          ...(args.path === undefined ? {} : { path: args.path }),
          ...(args.content === undefined ? {} : { content: args.content }),
          ...(args.taskId === undefined ? {} : { taskId: args.taskId }),
        }),
      ),
  );

  server.tool("team_get_artifact", "One artifact", { artifactId: z.string().min(1) }, async (args) =>
    ok(service.getArtifact(args.artifactId)),
  );

  server.tool("team_list_artifacts", "Everything the team has published", {}, async () =>
    ok(service.listArtifacts()),
  );

  server.tool(
    "team_record_decision",
    "Record a decision and the reason for it, so it is not relitigated",
    {
      title: z.string().min(1).max(300),
      reason: z.string().max(20_000).optional(),
      decision: z.string().min(1).max(20_000),
      relatedTasks: z.array(z.string()).optional(),
    },
    async (args) =>
      attempt(() =>
        service.recordDecision({
          author: agentId,
          title: args.title,
          ...(args.reason === undefined ? {} : { reason: args.reason }),
          decision: args.decision,
          ...(args.relatedTasks === undefined ? {} : { relatedTasks: args.relatedTasks }),
        }),
      ),
  );

  server.tool("team_get_decisions", "The decision log", {}, async () =>
    ok(service.getDecisions()),
  );

  server.tool(
    "team_finish_goal",
    "Declare the goal reached. Only the lead agent may do this",
    { outcome: z.string().min(1).max(20_000) },
    async (args) =>
      attempt(() => {
        if (service.team.leadAgentId && service.team.leadAgentId !== agentId) {
          throw new TeamRuleError("Only the lead agent finishes the goal");
        }
        return service.finishGoal(args.outcome, agentId);
      }),
  );

  return server;
}

/** Connects a scoped team server to a transport, e.g. a stdio child process. */
export async function serveTeamMcp(
  options: TeamMcpServerOptions & { transport: Transport },
): Promise<McpServer> {
  const server = createTeamMcpServer(options);
  await server.connect(options.transport);
  return server;
}

/**
 * The scope a provider is handed the team server under (spec §42).
 *
 * A provider that speaks MCP reaches the team as one of its own MCP servers:
 * one stdio entry per agent, so the connection always belongs to exactly the
 * agent the provider is answering as. The scope travels in the environment of
 * the server the provider spawns, never in the tool arguments, which is also
 * how a future stdio bridge process recovers whom it serves.
 */

/** Stable id under which the team server is handed to providers. */
export const TEAM_MCP_SERVER_ID = "team";

/** Environment carrying the scope into the stdio server a provider spawns. */
export const TEAM_MCP_RUN_ENV = "AI_WORKBENCH_TEAM_RUN_ID";
export const TEAM_MCP_AGENT_ENV = "AI_WORKBENCH_TEAM_AGENT_ID";

/** Which run and agent one team MCP connection belongs to. */
export interface TeamMcpScope {
  readonly runId: string;
  readonly agentId: string;
}

/** How the provider spawns the scoped server; the scope is added as env. */
export interface TeamMcpStdio {
  readonly command: string;
  readonly args?: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
  readonly cwd?: string;
}

/** The scope as environment variables for the spawned server. */
export function teamMcpScopeEnv(scope: TeamMcpScope): Record<string, string> {
  return {
    [TEAM_MCP_RUN_ENV]: scope.runId,
    [TEAM_MCP_AGENT_ENV]: scope.agentId,
  };
}

/** Reads the scope back from a spawned server's environment, if present. */
export function parseTeamMcpScope(
  env: Readonly<Record<string, string | undefined>>,
): TeamMcpScope | null {
  const runId = env[TEAM_MCP_RUN_ENV];
  const agentId = env[TEAM_MCP_AGENT_ENV];
  if (!runId || !agentId) {
    return null;
  }
  return { runId, agentId };
}

/**
 * The stdio server entry handing this scope to a provider: the configured
 * spawn plus the scope in its environment, so each agent gets its own
 * connection and can never act as another.
 */
export function describeTeamMcpServer(scope: TeamMcpScope, stdio: TeamMcpStdio): McpServerConfig {
  return {
    id: TEAM_MCP_SERVER_ID,
    name: "ai-workbench-team-mcp",
    transport: "stdio",
    command: stdio.command,
    args: stdio.args ? [...stdio.args] : [],
    env: { ...stdio.env, ...teamMcpScopeEnv(scope) },
    ...(stdio.cwd === undefined ? {} : { cwd: stdio.cwd }),
    enabled: true,
  };
}
