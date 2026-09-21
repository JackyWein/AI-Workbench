import { describe, expect, it } from "vitest";
import type { ProviderToolAccess } from "@ai-workbench/provider-base";
import {
  buildMcpLaunch,
  mcpServersFor,
  withTeamMcpServer,
  type CliMcpServer,
} from "../mcp.js";

const fileServer: CliMcpServer = {
  id: "files",
  name: "Files",
  transport: "stdio",
  command: "files-mcp",
  args: [],
  env: {},
};

const teamServer: CliMcpServer = {
  id: "team",
  name: "ai-workbench-team-mcp",
  transport: "stdio",
  command: "team-mcp",
  args: [],
  env: { AI_WORKBENCH_TEAM_RUN_ID: "run-1", AI_WORKBENCH_TEAM_AGENT_ID: "worker" },
};

function providerMcpAccess(servers: readonly CliMcpServer[]): ProviderToolAccess {
  return { kind: "provider-mcp", mcpServers: [...servers], hostTools: [] };
}

describe("withTeamMcpServer", () => {
  it("appends the scoped team server to the session servers", () => {
    expect(withTeamMcpServer([fileServer], teamServer)).toEqual([fileServer, teamServer]);
  });

  it("replaces a same-named entry instead of shadowing it", () => {
    const stale: CliMcpServer = { ...teamServer, command: "stale-team-mcp" };
    expect(withTeamMcpServer([fileServer, stale], teamServer)).toEqual([
      fileServer,
      teamServer,
    ]);
  });

  it("passes the list through when there is no team server", () => {
    const servers = [fileServer];
    const result = withTeamMcpServer(servers, null);
    expect(result).toEqual(servers);
    expect(result).not.toBe(servers);
  });
});

describe("team server on the CLI call", () => {
  it("reaches a json-arg tool with its scope", () => {
    const servers = withTeamMcpServer(mcpServersFor(providerMcpAccess([fileServer])), teamServer);
    const launch = buildMcpLaunch(
      { via: "json-arg", args: ["--mcp-config", "{mcpConfig}"] },
      servers,
    );

    expect(launch.args.length).toBe(2);
    const raw = launch.args[1];
    if (raw === undefined) {
      throw new Error("expected the CLI call to carry an MCP config argument");
    }
    const parsed = JSON.parse(raw) as {
      mcpServers: Record<string, { command?: unknown; env?: Record<string, string> }>;
    };
    expect(parsed.mcpServers["files"]?.command).toBe("files-mcp");
    expect(parsed.mcpServers["team"]?.command).toBe("team-mcp");
    expect(parsed.mcpServers["team"]?.env?.["AI_WORKBENCH_TEAM_RUN_ID"]).toBe("run-1");
    expect(parsed.mcpServers["team"]?.env?.["AI_WORKBENCH_TEAM_AGENT_ID"]).toBe("worker");
  });

  it("reaches an env-json tool with its scope", () => {
    const launch = buildMcpLaunch(
      { via: "env-json", variable: "TOOL_MCP", root: "mcp" },
      withTeamMcpServer([fileServer], teamServer),
    );

    const raw = launch.env["TOOL_MCP"];
    if (raw === undefined) {
      throw new Error("expected the CLI call to carry MCP config in the environment");
    }
    const parsed = JSON.parse(raw) as {
      mcp: Record<string, { command?: unknown; env?: Record<string, string> }>;
    };
    expect(parsed.mcp["team"]?.command).toBe("team-mcp");
    expect(parsed.mcp["team"]?.env?.["AI_WORKBENCH_TEAM_RUN_ID"]).toBe("run-1");
  });

  it("reaches a config-overrides tool with its scope", () => {
    const launch = buildMcpLaunch(
      { via: "config-overrides", flag: "--cfg", root: "mcp" },
      withTeamMcpServer([], teamServer),
    );

    const joined = launch.args.join("\n");
    expect(joined).toContain("mcp.team.command");
    expect(joined).toContain("team-mcp");
    expect(joined).toContain("AI_WORKBENCH_TEAM_RUN_ID");
    expect(joined).toContain("run-1");
  });

  it("is not handed to a tool that takes no servers", () => {
    const launch = buildMcpLaunch({ via: "none" }, withTeamMcpServer([], teamServer));
    expect(launch.args).toEqual([]);
    expect(launch.env).toEqual({});
  });

  it("only travels with provider-mcp access", () => {
    const hosted: ProviderToolAccess = { kind: "host-mediated", mcpServers: [], hostTools: [] };
    expect(mcpServersFor(hosted)).toEqual([]);
    expect(mcpServersFor(undefined)).toEqual([]);
    expect(mcpServersFor(providerMcpAccess([fileServer]))).toEqual([fileServer]);
  });
});
