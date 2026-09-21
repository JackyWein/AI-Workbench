import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseMcpServerConfig } from "@ai-workbench/shared";
import { McpManager } from "../manager.js";

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

  it("reports a remote transport as configured but not implemented", async () => {
    manager = new McpManager({ logger: nullLogger });
    const status = await manager.connect({
      id: "remote",
      name: "Remote",
      transport: "sse",
      url: "https://example.com/mcp",
    });

    expect(status.state).toBe("unsupported");
    expect(status.detail).toContain("not implemented");
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
