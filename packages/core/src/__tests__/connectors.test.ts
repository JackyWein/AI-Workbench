import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeTempDirectory, removeTempDirectory } from "@ai-workbench/test-support";
import { createDatabase, runMigrations, type DatabaseHandle } from "@ai-workbench/database";
import { McpManager } from "@ai-workbench/mcp";
import type { InteractiveLaunch, InteractiveLaunchRequest } from "@ai-workbench/provider-base";
import { MockProviderAdapter } from "@ai-workbench/provider-mock";
import type { McpServerConfig, ProviderCapabilities } from "@ai-workbench/shared";
import { AgentTerminalService } from "../agent-terminal-service.js";
import { EventBus } from "../event-bus.js";
import { createNullLogger } from "../logger.js";
import { McpService, availableServers } from "../mcp-service.js";
import { ProviderManager } from "../provider-manager.js";
import { SessionManager } from "../session-manager.js";
import { WorkspaceManager } from "../workspace-manager.js";

const base = {
  args: [],
  env: {},
  enabled: true,
  availability: "everywhere" as const,
  workspaceIds: [],
};

function server(id: string, extra: Partial<McpServerConfig> = {}): McpServerConfig {
  return { id, name: id, transport: "stdio", command: "server", ...base, ...extra };
}

describe("where a connector may be used", () => {
  const configs = [
    server("everywhere"),
    server("only-a", { availability: "workspaces", workspaceIds: ["ws-a"] }),
    server("off", { enabled: false }),
  ];

  it("is everywhere, or only in its workspaces, and never when it is off", () => {
    expect(availableServers(configs, "ws-a", new Map())).toEqual(["everywhere", "only-a"]);
    expect(availableServers(configs, "ws-b", new Map())).toEqual(["everywhere"]);
    expect(availableServers(configs, null, new Map())).toEqual(["everywhere"]);
  });

  it("lets a session switch one off, or on, for itself", () => {
    const overrides = new Map([
      ["everywhere", false],
      ["only-a", true],
      ["off", true],
    ]);
    // A switched-off server stays off, whatever the session says.
    expect(availableServers(configs, "ws-b", overrides)).toEqual(["only-a"]);
  });
});

describe("connectors in sessions and terminal agents", () => {
  let directory: string;
  let database: DatabaseHandle;
  let mcp: McpService;
  let secrets: Map<string, string>;
  let workspaceId: string;
  let otherWorkspaceId: string;
  let workspaces: WorkspaceManager;
  let providers: ProviderManager;
  const events = new EventBus();
  const logger = createNullLogger();
  const gateway = {
    endpointFor: (id: string) => ({
      url: `http://127.0.0.1:9/mcp/${id}`,
      headers: { Authorization: "Bearer gateway-key" },
    }),
    endpointForAll: (ids: readonly string[]) => ({
      url: `http://127.0.0.1:9/mcp-all/${ids.join("-")}`,
      headers: {},
    }),
  };
  const capabilities: ProviderCapabilities = { supported: ["chat", "mcp"] };

  beforeEach(async () => {
    directory = await makeTempDirectory("connectors-");
    database = createDatabase({ file: join(directory, "test.db") });
    await runMigrations(database.client);
    secrets = new Map();
    let next = 1;
    mcp = new McpService({
      db: database.db,
      logger,
      manager: new McpManager({ logger }),
      gateway,
      credentials: {
        resolve: async (reference) => secrets.get(reference) ?? null,
        store: async (_label, secret, reference) => {
          const key = reference ?? `cred_${next++}`;
          secrets.set(key, secret);
          return key;
        },
        delete: async (reference) => {
          secrets.delete(reference);
        },
      },
    });
    workspaces = new WorkspaceManager({ db: database.db, events, logger });
    for (const name of ["a", "b"]) {
      await mkdir(join(directory, name), { recursive: true });
    }
    workspaceId = (await workspaces.create({ name: "A", path: join(directory, "a") })).id;
    otherWorkspaceId = (await workspaces.create({ name: "B", path: join(directory, "b") })).id;
    providers = new ProviderManager({ logger, stateDirectory: join(directory, "providers") });
  });

  afterEach(async () => {
    await mcp.manager.disconnectAll();
    database.close();
    await removeTempDirectory(directory);
  });

  it("is available in every session by default, and a session can switch it off", async () => {
    await mcp.save({ ...server("files"), transport: "http", url: "https://files.example/mcp", command: undefined });
    const sessions = new SessionManager({ db: database.db, events, logger, providers, workspaces, mcp });
    await providers.register(new MockProviderAdapter());
    const session = await sessions.create({ workspaceId, name: "Chat", type: "solo", providerId: "mock" });

    expect(await mcp.enabledForSession(session.id)).toEqual(["files"]);
    await mcp.setSessionAccess(session.id, "files", false);
    expect(await mcp.enabledForSession(session.id)).toEqual([]);
  });

  it("stores a new API key in the credential store and only keeps its reference", async () => {
    const saved = await mcp.saveFromWindow({
      id: "tracker",
      name: "Tracker",
      transport: "http",
      url: "https://tracker.example/mcp",
      apiKey: "tk-secret-value",
    });
    expect(saved.credentialReference).toBeDefined();
    expect(JSON.stringify(saved)).not.toContain("tk-secret-value");
    expect(secrets.get(saved.credentialReference ?? "")).toBe("tk-secret-value");

    const route = await mcp.gatewayRoute("tracker");
    expect(await route?.authorization(false)).toBe("Bearer tk-secret-value");

    await mcp.delete("tracker");
    expect(secrets.size).toBe(0);
  });

  it("hands tools the gateway for servers that need a credential, and the server itself otherwise", async () => {
    await mcp.save({ ...server("local"), command: "npx", args: ["files-server"] });
    await mcp.save({ ...server("open"), transport: "http", url: "https://open.example/mcp", command: undefined });
    await mcp.save({
      ...server("signed"),
      transport: "http",
      url: "https://signed.example/mcp",
      command: undefined,
      oauth: { scopes: [] },
    });

    const access = await mcp.toolAccess(capabilities, ["local", "open", "signed"]);
    const byId = new Map(access?.mcpServers.map((entry) => [entry.id, entry]));
    expect(byId.get("local")).toMatchObject({ command: "npx", args: ["files-server"] });
    expect(byId.get("open")).toMatchObject({ url: "https://open.example/mcp" });
    expect(byId.get("open")?.headers).toBeUndefined();
    expect(byId.get("signed")).toMatchObject({
      url: "http://127.0.0.1:9/mcp/signed",
      headers: { Authorization: "Bearer gateway-key" },
    });
    // No token ever reaches the tool: signed-in servers go through the gateway.
    expect(JSON.stringify(access)).not.toContain("signed.example");
    expect(access?.combined?.url).toBe("http://127.0.0.1:9/mcp-all/local-open-signed");
  });

  it("gives a terminal agent the connectors of its workspace", async () => {
    await mcp.save({ ...server("everywhere"), command: "a" });
    await mcp.save({ ...server("only-b"), command: "b", availability: "workspaces", workspaceIds: [otherWorkspaceId] });
    const requests: InteractiveLaunchRequest[] = [];
    class Recording extends MockProviderAdapter {
      describeInteractiveLaunch = async (request: InteractiveLaunchRequest): Promise<InteractiveLaunch> => {
        requests.push(request);
        return { command: "/bin/true", args: [], env: {}, cwd: request.workingDirectory };
      };
      override async getCapabilities(): Promise<ProviderCapabilities> {
        return capabilities;
      }
    }
    await providers.register(new Recording());
    const service = new AgentTerminalService({
      db: database.db,
      events,
      logger,
      providers,
      workspaces,
      terminals: { create: () => ({ id: "term-1" }), close: () => true, write: () => undefined },
      resolveCommand: (launch) => ({ file: launch.command, args: launch.args, env: launch.env }),
      mcp,
    });

    await service.launch({ workspaceId, providerId: "mock" });
    expect(requests[0]?.toolAccess?.mcpServers.map((entry) => entry.id)).toEqual(["everywhere"]);
    await service.launch({ workspaceId: otherWorkspaceId, providerId: "mock" });
    expect(requests[1]?.toolAccess?.mcpServers.map((entry) => entry.id)).toEqual(["everywhere", "only-b"]);
  });
});
