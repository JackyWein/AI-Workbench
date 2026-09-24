import { describe, expect, it } from "vitest";
import type { McpServerConfig } from "@ai-workbench/shared";
import { describeFinding, serverId, toSaveInput, type ToolMcpFinding } from "../tool-mcp-import.js";

const stitch: ToolMcpFinding = {
  key: "k1",
  providerId: "claude-code",
  providerName: "Claude Code",
  server: {
    name: "stitch",
    source: "Claude Code · your servers",
    transport: "http",
    args: [],
    env: {},
    url: "https://stitch.example.com/mcp",
    headers: { "X-Goog-Api-Key": "secret-value" },
  },
};

const roblox: ToolMcpFinding = {
  key: "k2",
  providerId: "codex",
  providerName: "Codex",
  server: {
    name: "Roblox_Studio",
    source: "Codex · config.toml",
    transport: "stdio",
    command: "cmd.exe",
    args: ["/c", "mcp.bat", "--api-token", "abc123"],
    env: { MODE: "studio", ROBLOX_API_KEY: "hidden" },
    headers: {},
  },
};

describe("importing MCP servers from the person's tools", () => {
  it("shows the window the names of secrets, never their values", () => {
    const shown = describeFinding(roblox, []);
    expect(JSON.stringify(shown)).not.toContain("abc123");
    expect(JSON.stringify(shown)).not.toContain("hidden");
    expect(shown.args).toEqual(["/c", "mcp.bat", "--api-token", "••••"]);
    expect(shown.secretNames).toEqual(["ROBLOX_API_KEY"]);
    expect(describeFinding(stitch, []).secretNames).toEqual(["X-Goog-Api-Key"]);
  });

  it("says a server is already there by its name", () => {
    const existing = [{ id: "stitch", name: "stitch" } as McpServerConfig];
    expect(describeFinding(stitch, existing).imported).toBe(true);
    expect(describeFinding(roblox, existing).imported).toBe(false);
  });

  it("turns a service's own key header into a stored key sent in that header", () => {
    const { input, notes } = toSaveInput(stitch, new Set());
    expect(input).toMatchObject({
      id: "stitch",
      transport: "http",
      url: "https://stitch.example.com/mcp",
      apiKey: "secret-value",
      apiKeyHeader: "X-Goog-Api-Key",
      availability: "everywhere",
    });
    expect(notes).toEqual([]);
  });

  it("keeps plain variables and names the secret ones instead of copying them", () => {
    const { input, notes } = toSaveInput(roblox, new Set(["roblox-studio"]));
    expect(input.id).toBe("roblox-studio-2");
    expect(input.env).toEqual({ MODE: "studio" });
    expect(notes).toEqual([
      "ROBLOX_API_KEY holds a secret and was not copied; set it in the server's settings.",
    ]);
  });

  it("makes ids from names", () => {
    expect(serverId("Roblox_Studio")).toBe("roblox-studio");
    expect(serverId("  !! ")).toBe("server");
  });
});
