import { describe, expect, it } from "vitest";
import type { McpServerConfig, McpServerStatus } from "@ai-workbench/shared";
import { ToolBridge } from "../tool-bridge.js";

function config(id: string, enabled = true): McpServerConfig {
  return {
    id,
    name: id,
    transport: "stdio",
    command: "server",
    args: [],
    env: {},
    enabled,
    availability: "everywhere",
    workspaceIds: [],
  };
}

function status(id: string, state: McpServerStatus["state"]): McpServerStatus {
  return {
    id,
    name: id,
    transport: "stdio",
    state,
    tools: [],
    updatedAt: new Date(),
  };
}

const toolsFor = (ids: readonly string[]) =>
  ids.map((serverId) => ({
    serverId,
    name: `${serverId}-tool`,
    description: "",
    inputSchema: {},
  }));

describe("ToolBridge", () => {
  const bridge = new ToolBridge();

  it("hands servers to a provider that speaks MCP itself", () => {
    const plan = bridge.plan({
      capabilities: { supported: ["chat", "mcp", "toolCalls"] },
      enabledServerIds: ["files"],
      configs: [config("files")],
      statuses: [status("files", "connected")],
      toolsFor,
    });

    expect(plan.kind).toBe("provider-mcp");
    expect(plan.mcpServers.map((entry) => entry.id)).toEqual(["files"]);
    expect(plan.hostTools).toEqual([]);
  });

  it("executes tools for a provider that only has tool calls", () => {
    const plan = bridge.plan({
      capabilities: { supported: ["chat", "toolCalls"] },
      enabledServerIds: ["files"],
      configs: [config("files")],
      statuses: [status("files", "connected")],
      toolsFor,
    });

    expect(plan.kind).toBe("host-mediated");
    expect(plan.hostTools.map((tool) => tool.name)).toEqual(["files-tool"]);
    expect(plan.mcpServers).toEqual([]);
  });

  it("gives nothing to a provider that cannot use tools", () => {
    const plan = bridge.plan({
      capabilities: { supported: ["chat", "streaming"] },
      enabledServerIds: ["files"],
      configs: [config("files")],
      statuses: [status("files", "connected")],
      toolsFor,
    });

    expect(plan.kind).toBe("none");
    expect(plan.reason).toContain("cannot use tools");
  });

  it("explains why an enabled server is not usable", () => {
    const plan = bridge.plan({
      capabilities: { supported: ["mcp"] },
      enabledServerIds: ["gone", "off", "broken"],
      configs: [config("off", false), config("broken")],
      statuses: [status("broken", "failed")],
      toolsFor,
    });

    expect(plan.kind).toBe("none");
    expect(plan.unavailable).toEqual([
      { id: "gone", reason: "The server is no longer configured" },
      { id: "off", reason: "The server is switched off" },
      { id: "broken", reason: "The server is failed" },
    ]);
  });

  it("uses the servers that work even when another is broken", () => {
    const plan = bridge.plan({
      capabilities: { supported: ["mcp"] },
      enabledServerIds: ["good", "broken"],
      configs: [config("good"), config("broken")],
      statuses: [status("good", "connected"), status("broken", "failed")],
      toolsFor,
    });

    expect(plan.kind).toBe("provider-mcp");
    expect(plan.mcpServers.map((entry) => entry.id)).toEqual(["good"]);
    expect(plan.unavailable).toHaveLength(1);
  });

  it("reports nothing enabled as a plain reason", () => {
    const plan = bridge.plan({
      capabilities: { supported: ["mcp"] },
      enabledServerIds: [],
      configs: [config("files")],
      statuses: [],
      toolsFor,
    });
    expect(plan.kind).toBe("none");
    expect(plan.reason).toContain("No usable MCP server");
  });
});
