import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeTempDirectory, removeTempDirectory } from "@ai-workbench/test-support";
import { createDatabase, runMigrations, type DatabaseHandle } from "@ai-workbench/database";
import { McpManager } from "@ai-workbench/mcp";
import type {
  AgentMessage,
  AIProviderAdapter,
  ProviderContext,
  ProviderSessionConfig,
  ProviderSessionHandle,
  ProviderSessionInfo,
} from "@ai-workbench/provider-base";
import { buildMcpLaunch, mcpServersFor } from "@ai-workbench/provider-cli";
import type {
  AuthStatus,
  InstallationStatus,
  ModelInfo,
  ProviderCapabilities,
  ProviderEvent,
  ProviderMetadata,
} from "@ai-workbench/shared";
import { TEAM_MCP_AGENT_ENV, TEAM_MCP_RUN_ENV, TEAM_MCP_SERVER_ID } from "@ai-workbench/team";
import { EventBus } from "../event-bus.js";
import { createNullLogger } from "../logger.js";
import { McpService } from "../mcp-service.js";
import { ProviderManager } from "../provider-manager.js";
import { TeamManager } from "../team-manager.js";
import { WorkspaceManager } from "../workspace-manager.js";

/**
 * G5 handover proof: the team MCP server reaches a provider that speaks MCP
 * as one of its own MCP servers — scoped per agent, alongside the servers
 * selected for the session, and visible on the CLI call. No real provider is
 * involved, so nothing here spends quota.
 */

const echoServer = join(
  import.meta.dirname,
  "../../../mcp/src/__tests__/fixtures/echo-server.mjs",
);

/** An MCP-speaking provider that costs nothing and ends the goal at once. */
class RecordingAdapter implements AIProviderAdapter {
  readonly metadata: ProviderMetadata;
  readonly configs: ProviderSessionConfig[] = [];

  constructor(
    readonly id: string,
    readonly mcpCapable: boolean,
  ) {
    this.metadata = {
      id,
      displayName: id,
      adapterVersion: "1.0.0",
      authMethods: ["none"],
      transportTypes: ["in-process"],
    };
  }

  async initialize(_context: ProviderContext): Promise<void> {
    // Nothing to set up; sessions are recorded in memory.
  }

  async dispose(): Promise<void> {
    // Nothing held.
  }

  async detectInstallation(): Promise<InstallationStatus> {
    return { state: "installed", detail: "Runs in-process; nothing to install" };
  }

  async getAuthenticationStatus(): Promise<AuthStatus> {
    return { state: "notApplicable", method: "none" };
  }

  async getCapabilities(): Promise<ProviderCapabilities> {
    return {
      supported: this.mcpCapable
        ? ["chat", "streaming", "sessionResume", "modelSelection", "mcp"]
        : ["chat", "streaming", "sessionResume", "modelSelection"],
    };
  }

  async listModels(): Promise<ModelInfo[]> {
    return [];
  }

  async createSession(config: ProviderSessionConfig): Promise<ProviderSessionInfo> {
    this.configs.push(config);
    return { providerSessionId: `recording-${config.sessionId}`, resumable: true };
  }

  async *sendMessage(
    _session: ProviderSessionHandle,
    _message: AgentMessage,
  ): AsyncIterable<ProviderEvent> {
    yield {
      type: "text_delta",
      text: 'Done.\n\n```team\n{"action": "finish_goal", "outcome": "handover complete"}\n```',
    };
    yield { type: "completed", reason: "finished" };
  }

  async cancel(_session: ProviderSessionHandle): Promise<void> {
    // Nothing running.
  }

  async destroySession(_session: ProviderSessionHandle): Promise<void> {
    // Nothing held.
  }
}

interface Harness {
  readonly teams: TeamManager;
  readonly workspaces: WorkspaceManager;
  readonly recorder: RecordingAdapter;
  readonly manager: McpManager;
  readonly providers: ProviderManager;
  readonly database: DatabaseHandle;
  dispose(): Promise<void>;
}

async function boot(
  directory: string,
  recorder: RecordingAdapter,
  withEcho: boolean,
): Promise<Harness> {
  const logger = createNullLogger();
  const database = createDatabase({ file: join(directory, "test.db") });
  await runMigrations(database.client);

  const events = new EventBus();
  const providers = new ProviderManager({
    logger,
    stateDirectory: join(directory, "providers"),
  });
  await providers.register(recorder);

  const workspaces = new WorkspaceManager({ db: database.db, events, logger });
  const manager = new McpManager({ logger });
  const mcp = new McpService({ db: database.db, logger, manager });
  if (withEcho) {
    await mcp.save({
      id: "echo",
      name: "Echo",
      transport: "stdio",
      command: process.execPath,
      args: [echoServer],
    });
    await mcp.connectEnabled();
  }

  const teams = new TeamManager({
    db: database.db,
    events,
    logger,
    providers,
    mcp,
    teamMcp: { command: "team-mcp-stub", args: ["--scope-env"] },
  });

  return {
    teams,
    workspaces,
    recorder,
    manager,
    providers,
    database,
    dispose: async () => {
      await teams.shutdown();
      await providers.dispose();
      await manager.disconnectAll();
      database.close();
    },
  };
}

/** Waits for the run to leave "running", which is when the loop has settled. */
async function settle(app: Harness, runId: string, timeoutMs = 15_000): Promise<void> {
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

describe("team MCP handover to providers", () => {
  let directory = "";
  let app: Harness | undefined;

  afterEach(async () => {
    if (app) {
      await app.dispose();
      app = undefined;
    }
    if (directory) {
      await removeTempDirectory(directory);
    }
  });

  beforeEach(async () => {
    directory = await makeTempDirectory("ai-workbench-team-handover-");
  });

  it("hands the scoped team server plus the selected session server to the CLI call", async () => {
    app = await boot(directory, new RecordingAdapter("recording-mcp", true), true);

    const workspace = await app.workspaces.create({ name: "Demo", path: directory });
    const team = await app.teams.create({
      workspaceId: workspace.id,
      workingDirectory: workspace.path,
      name: "Handover",
      agents: [
        {
          displayName: "Lead",
          providerId: "recording-mcp",
          role: "leads",
          mcpServers: ["echo"],
        },
      ],
    });
    const run = await app.teams.startRun({ teamId: team.id, goal: "Prove the handover" });
    await settle(app, run.id);

    const snapshot = await app.teams.getSnapshot(run.id);
    expect(snapshot.run.status).toBe("completed");

    expect(app.recorder.configs).toHaveLength(1);
    const toolAccess = app.recorder.configs[0]?.toolAccess;
    expect(toolAccess?.kind).toBe("provider-mcp");
    expect(toolAccess?.mcpServers.map((server) => server.id)).toEqual([
      "echo",
      TEAM_MCP_SERVER_ID,
    ]);

    const teamServer = toolAccess?.mcpServers.find(
      (server) => server.id === TEAM_MCP_SERVER_ID,
    );
    expect(teamServer?.transport).toBe("stdio");
    expect(teamServer?.command).toBe("team-mcp-stub");
    expect(teamServer?.env?.[TEAM_MCP_RUN_ENV]).toBe(run.id);
    expect(teamServer?.env?.[TEAM_MCP_AGENT_ENV]).toBe(team.agents[0]?.id);

    // And the servers reach the CLI call itself, the team one scoped per agent.
    const launch = buildMcpLaunch(
      { via: "json-arg", args: ["--mcp-config", "{mcpConfig}"] },
      mcpServersFor(toolAccess),
    );
    expect(launch.args.length).toBe(2);
    const raw = launch.args[1];
    if (raw === undefined) {
      throw new Error("expected the CLI call to carry an MCP config argument");
    }
    const parsed = JSON.parse(raw) as {
      mcpServers: Record<string, { command?: unknown; env?: Record<string, string> }>;
    };
    expect(parsed.mcpServers["echo"]?.command).toBe(process.execPath);
    expect(parsed.mcpServers[TEAM_MCP_SERVER_ID]?.command).toBe("team-mcp-stub");
    expect(parsed.mcpServers[TEAM_MCP_SERVER_ID]?.env?.[TEAM_MCP_RUN_ENV]).toBe(run.id);
    expect(parsed.mcpServers[TEAM_MCP_SERVER_ID]?.env?.[TEAM_MCP_AGENT_ENV]).toBe(
      team.agents[0]?.id,
    );
  });

  it("hands only the team server when nothing else is selected", async () => {
    app = await boot(directory, new RecordingAdapter("recording-mcp", true), false);

    const workspace = await app.workspaces.create({ name: "Demo", path: directory });
    const team = await app.teams.create({
      workspaceId: workspace.id,
      workingDirectory: workspace.path,
      name: "Handover",
      agents: [{ displayName: "Lead", providerId: "recording-mcp", role: "leads" }],
    });
    const run = await app.teams.startRun({ teamId: team.id, goal: "Prove the handover" });
    await settle(app, run.id);

    expect((await app.teams.getSnapshot(run.id)).run.status).toBe("completed");
    const toolAccess = app.recorder.configs[0]?.toolAccess;
    expect(toolAccess?.kind).toBe("provider-mcp");
    expect(toolAccess?.mcpServers.map((server) => server.id)).toEqual([TEAM_MCP_SERVER_ID]);
  });

  it("keeps a provider without MCP on action blocks", async () => {
    app = await boot(directory, new RecordingAdapter("recording-plain", false), false);

    const workspace = await app.workspaces.create({ name: "Demo", path: directory });
    const team = await app.teams.create({
      workspaceId: workspace.id,
      workingDirectory: workspace.path,
      name: "Handover",
      agents: [{ displayName: "Lead", providerId: "recording-plain", role: "leads" }],
    });
    const run = await app.teams.startRun({ teamId: team.id, goal: "Prove the handover" });
    await settle(app, run.id);

    expect((await app.teams.getSnapshot(run.id)).run.status).toBe("completed");
    expect(app.recorder.configs).toHaveLength(1);
    expect(app.recorder.configs[0]?.toolAccess).toBeUndefined();
  });
});
