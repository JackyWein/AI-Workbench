import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseMcpServerConfig } from "@ai-workbench/shared";
import { McpManager } from "../manager.js";
import { startHttpTestServer, type HttpTestServer } from "./http-test-server.js";

const nullLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => nullLogger,
};

const echoServer = join(import.meta.dirname, "fixtures/echo-server.mjs");

function stdioConfig(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "echo",
    name: "Echo server",
    transport: "stdio",
    command: process.execPath,
    args: [echoServer],
    ...overrides,
  };
}

describe("server configuration", () => {
  it("requires a command for stdio and a url for remote transports", () => {
    expect(() => parseMcpServerConfig({ id: "a", name: "A", transport: "stdio" })).toThrow();
    expect(() => parseMcpServerConfig({ id: "a", name: "A", transport: "http" })).toThrow();

    expect(
      parseMcpServerConfig({
        id: "a",
        name: "A",
        transport: "http",
        url: "https://example.com/mcp",
      }).url,
    ).toBe("https://example.com/mcp");
  });

  it("defaults to stdio and enabled", () => {
    const config = parseMcpServerConfig({ id: "a", name: "A", command: "x" });
    expect(config.transport).toBe("stdio");
    expect(config.enabled).toBe(true);
  });
});

describe("McpManager against a real server", () => {
  let manager: McpManager;

  afterEach(async () => {
    await manager?.disconnectAll();
  });

  it("connects over stdio and reads the tool list", async () => {
    manager = new McpManager({ logger: nullLogger });
    const status = await manager.connect(stdioConfig());

    expect(status.state).toBe("connected");
    expect(status.tools.map((tool) => tool.name).sort()).toEqual([
      "add",
      "echo",
      "explode",
    ]);
    expect(status.tools.find((tool) => tool.name === "echo")?.description).toContain(
      "Returns the text",
    );
    expect(manager.isConnected("echo")).toBe(true);
  }, 30_000);

  it("calls a tool and returns its result", async () => {
    manager = new McpManager({ logger: nullLogger });
    await manager.connect(stdioConfig());

    const result = await manager.callTool("echo", "echo", { text: "hello" });
    expect(result.ok).toBe(true);
    expect(JSON.stringify(result)).toContain("echo:hello");

    const sum = await manager.callTool("echo", "add", { a: 2, b: 3 });
    expect(JSON.stringify(sum)).toContain("5");
  }, 30_000);

  it("reports a failing tool without throwing", async () => {
    manager = new McpManager({ logger: nullLogger });
    await manager.connect(stdioConfig());

    const result = await manager.callTool("echo", "explode", {});
    // The protocol reports the failure; the manager passes it on as data.
    expect(JSON.stringify(result)).toContain("exploded");
  }, 30_000);

  it("reports a server that cannot start as failed", async () => {
    manager = new McpManager({ logger: nullLogger });
    const status = await manager.connect(
      stdioConfig({ id: "broken", command: "definitely-not-a-command" }),
    );

    expect(status.state).toBe("failed");
    expect(status.detail).toBeTruthy();
    expect(manager.isConnected("broken")).toBe(false);
  }, 30_000);

  it("keeps a broken server from affecting a working one", async () => {
    manager = new McpManager({ logger: nullLogger });
    await manager.connect(stdioConfig());
    await manager.connect(stdioConfig({ id: "broken", command: "definitely-not-a-command" }));

    const statuses = manager.statuses();
    expect(statuses.find((entry) => entry.id === "echo")?.state).toBe("connected");
    expect(statuses.find((entry) => entry.id === "broken")?.state).toBe("failed");

    // The healthy server still answers.
    expect((await manager.callTool("echo", "echo", { text: "still here" })).ok).toBe(true);
  }, 30_000);

  it("reports invalid configuration instead of throwing", async () => {
    manager = new McpManager({ logger: nullLogger });
    const status = await manager.connect({ id: "bad", name: "Bad", transport: "stdio" });
    expect(status.state).toBe("failed");
  });

  it("reports an unreachable remote server as failed instead of throwing", async () => {
    manager = new McpManager({ logger: nullLogger });
    for (const transport of ["http", "sse"] as const) {
      const status = await manager.connect({
        id: `remote-${transport}`,
        name: `Remote ${transport}`,
        transport,
        url: "http://127.0.0.1:1/mcp",
      });

      expect(status.state).toBe("failed");
      expect(status.detail).toBeTruthy();
      expect(manager.isConnected(`remote-${transport}`)).toBe(false);
    }
  });

  it("exposes only the tools a session is allowed to use", async () => {
    manager = new McpManager({ logger: nullLogger });
    await manager.connect(stdioConfig());
    await manager.connect(stdioConfig({ id: "second", name: "Second" }));

    expect(manager.toolsForSession(["echo"])).toHaveLength(3);
    expect(manager.toolsForSession(["echo", "second"])).toHaveLength(6);
    expect(manager.toolsForSession([])).toEqual([]);
    // A server that is not connected contributes nothing.
    expect(manager.toolsForSession(["nope"])).toEqual([]);
  }, 30_000);

  it("disconnects and forgets the tools", async () => {
    manager = new McpManager({ logger: nullLogger });
    await manager.connect(stdioConfig());

    expect(await manager.disconnect("echo")).toBe(true);
    expect(manager.isConnected("echo")).toBe(false);
    expect(manager.status("echo")?.state).toBe("disconnected");
    expect(manager.toolsForSession(["echo"])).toEqual([]);
    expect(await manager.disconnect("echo")).toBe(false);
  }, 30_000);
});

describe("McpManager over streamable HTTP", () => {
  let manager: McpManager;
  let servers: HttpTestServer[] = [];

  afterEach(async () => {
    await manager?.disconnectAll();
    await Promise.all(servers.splice(0).map((server) => server.close()));
  });

  function httpConfig(url: string, overrides: Record<string, unknown> = {}) {
    return {
      id: "remote",
      name: "Remote server",
      transport: "http",
      url,
      ...overrides,
    };
  }

  it("connects over http, reads the tool list and reports latency", async () => {
    servers = [await startHttpTestServer()];
    manager = new McpManager({ logger: nullLogger });
    const status = await manager.connect(httpConfig(servers[0]?.url ?? ""));

    expect(status.state).toBe("connected");
    expect(status.tools.map((tool) => tool.name).sort()).toEqual([
      "add",
      "echo",
      "explode",
    ]);
    expect(typeof status.latencyMs).toBe("number");
    expect(status.latencyMs as number).toBeGreaterThanOrEqual(0);
    expect(manager.isConnected("remote")).toBe(true);
  }, 30_000);

  it("calls a tool and filters remote tools per session like stdio", async () => {
    servers = [await startHttpTestServer()];
    manager = new McpManager({ logger: nullLogger });
    await manager.connect(httpConfig(servers[0]?.url ?? ""));

    const result = await manager.callTool("remote", "echo", { text: "hello" });
    expect(result.ok).toBe(true);
    expect(JSON.stringify(result)).toContain("echo:hello");

    const sum = await manager.callTool("remote", "add", { a: 2, b: 3 });
    expect(JSON.stringify(sum)).toContain("5");

    expect(manager.toolsForSession(["remote"]).map((tool) => tool.serverId)).toEqual([
      "remote",
      "remote",
      "remote",
    ]);
    expect(manager.toolsForSession([])).toEqual([]);
    expect(manager.toolsForSession(["nope"])).toEqual([]);
  }, 30_000);

  it("sends the resolved credential as an Authorization header", async () => {
    servers = [await startHttpTestServer({ expectedAuth: "Bearer test-secret" })];
    manager = new McpManager({
      logger: nullLogger,
      resolveCredential: async (reference) =>
        reference === "cred_test" ? "test-secret" : null,
    });

    const status = await manager.connect(
      httpConfig(servers[0]?.url ?? "", { credentialReference: "cred_test" }),
    );
    expect(status.state).toBe("connected");

    // A bare token gains the Bearer scheme; a ready-made value passes through.
    await manager.disconnect("remote");
    servers.push(await startHttpTestServer({ expectedAuth: "Basic dXNlcjpwYXNz" }));
    const basic = await manager.connect(
      httpConfig(servers[1]?.url ?? "", { credentialReference: "cred_test" }),
    );
    expect(basic.state).toBe("failed");

    manager.setCredentialResolver(async () => "Basic dXNlcjpwYXNz");
    const retry = await manager.connect(
      httpConfig(servers[1]?.url ?? "", { credentialReference: "cred_other" }),
    );
    expect(retry.state).toBe("connected");
  }, 30_000);

  it("reports an unresolvable credential as failed, never thrown", async () => {
    servers = [await startHttpTestServer({ expectedAuth: "Bearer test-secret" })];
    manager = new McpManager({
      logger: nullLogger,
      resolveCredential: async () => null,
    });

    const status = await manager.connect(
      httpConfig(servers[0]?.url ?? "", { credentialReference: "cred_missing" }),
    );
    expect(status.state).toBe("failed");
    expect(status.detail).toContain("cred_missing");
    expect(manager.isConnected("remote")).toBe(false);

    const withoutResolver = new McpManager({ logger: nullLogger });
    const refused = await withoutResolver.connect(
      httpConfig(servers[0]?.url ?? "", { credentialReference: "cred_missing" }),
    );
    expect(refused.state).toBe("failed");
    expect(refused.detail).toContain("no credential resolver");
    await withoutResolver.disconnectAll();
  }, 30_000);

  it("rejects a wrong secret with a failed status", async () => {
    servers = [await startHttpTestServer({ expectedAuth: "Bearer correct" })];
    manager = new McpManager({
      logger: nullLogger,
      resolveCredential: async () => "wrong",
    });

    const status = await manager.connect(
      httpConfig(servers[0]?.url ?? "", { credentialReference: "cred_test" }),
    );
    expect(status.state).toBe("failed");
    expect(status.detail).toBeTruthy();
  }, 30_000);

  it("probes health and records latency", async () => {
    servers = [await startHttpTestServer()];
    manager = new McpManager({ logger: nullLogger });
    await manager.connect(httpConfig(servers[0]?.url ?? ""));

    const health = await manager.health("remote");
    expect(health.ok).toBe(true);
    if (health.ok) {
      expect(health.latencyMs).toBeGreaterThanOrEqual(0);
    }
    expect(manager.status("remote")?.latencyMs).toBeGreaterThanOrEqual(0);

    expect(await manager.health("nope")).toEqual({
      ok: false,
      error: 'MCP server "nope" is not connected',
    });
  }, 30_000);

  it("reconnects a known server and gives up honestly on a dead one", async () => {
    servers = [await startHttpTestServer()];
    manager = new McpManager({ logger: nullLogger });
    await manager.connect(httpConfig(servers[0]?.url ?? ""));

    const back = await manager.reconnect("remote", { attempts: 2, baseDelayMs: 1 });
    expect(back.state).toBe("connected");

    const unknown = await manager.reconnect("nope");
    expect(unknown.state).toBe("failed");
    expect(unknown.detail).toContain("No configuration known");

    await manager.disconnectAll();
    await Promise.all(servers.splice(0).map((server) => server.close()));
    servers = [];
    const dead = await manager.reconnect("remote", { attempts: 2, baseDelayMs: 1 });
    expect(dead.state).toBe("failed");
    expect(dead.detail).toBeTruthy();
  }, 30_000);
});
