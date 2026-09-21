import { describe, expect, it } from "vitest";
import {
  describeTeamMcpServer,
  parseTeamMcpScope,
  TEAM_MCP_AGENT_ENV,
  TEAM_MCP_RUN_ENV,
  TEAM_MCP_SERVER_ID,
  teamMcpScopeEnv,
} from "../mcp-server.js";

describe("team MCP scope", () => {
  it("describes a stdio server scoped to one agent", () => {
    const server = describeTeamMcpServer(
      { runId: "run-1", agentId: "worker" },
      { command: "team-mcp", args: ["--stdio"], env: { EXTRA: "kept" } },
    );

    expect(server.id).toBe(TEAM_MCP_SERVER_ID);
    expect(server.transport).toBe("stdio");
    expect(server.command).toBe("team-mcp");
    expect(server.args).toEqual(["--stdio"]);
    expect(server.env[TEAM_MCP_RUN_ENV]).toBe("run-1");
    expect(server.env[TEAM_MCP_AGENT_ENV]).toBe("worker");
    expect(server.env["EXTRA"]).toBe("kept");
    expect(server.enabled).toBe(true);
  });

  it("scopes each agent differently", () => {
    const launch = { command: "team-mcp" };
    const lead = describeTeamMcpServer({ runId: "run-1", agentId: "lead" }, launch);
    const worker = describeTeamMcpServer({ runId: "run-1", agentId: "worker" }, launch);

    expect(lead.env[TEAM_MCP_AGENT_ENV]).toBe("lead");
    expect(worker.env[TEAM_MCP_AGENT_ENV]).toBe("worker");
    expect(lead.env).not.toEqual(worker.env);
  });

  it("round-trips the scope through the environment", () => {
    const scope = { runId: "run-9", agentId: "builder" };

    expect(parseTeamMcpScope(teamMcpScopeEnv(scope))).toEqual(scope);
    expect(parseTeamMcpScope({})).toBeNull();
    expect(parseTeamMcpScope({ [TEAM_MCP_RUN_ENV]: "run-9" })).toBeNull();
  });
});
