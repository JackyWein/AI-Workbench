import { describe, expect, it } from "vitest";
import type { McpServerConfig } from "@ai-workbench/shared";
import {
  describeFinding,
  fingerprintOf,
  serverId,
  toSaveInput,
  type ToolMcpFinding,
} from "../tool-mcp-import.js";

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

  it("keeps plain variables and moves the secret ones to secure storage", () => {
    const { input, secrets, notes } = toSaveInput(roblox, new Set(["roblox-studio"]));
    expect(input.id).toBe("roblox-studio-2");
    // Only plain variables are saved with the server...
    expect(input.env).toEqual({ MODE: "studio" });
    // ...the secret travels separately, for the credential store.
    expect(secrets).toEqual({ ROBLOX_API_KEY: "hidden" });
    // A secret passed as an argument cannot be moved; it is left out and named.
    expect(input.args).toEqual(["/c", "mcp.bat"]);
    expect(notes).toEqual([
      "ROBLOX_API_KEY is kept in secure storage; tools reach this server through the application.",
      "The argument --api-token holds a secret and was not copied; add it in the server's settings.",
    ]);
  });

  it("imports into this workspace only when asked, and updates a server imported before", () => {
    const scoped = toSaveInput(roblox, new Set(), { workspaceId: "ws-1" });
    expect(scoped.input).toMatchObject({ availability: "workspaces", workspaceIds: ["ws-1"] });
    const again = toSaveInput(roblox, new Set(["roblox-studio"]), { existingId: "roblox-studio" });
    expect(again.input.id).toBe("roblox-studio");
    expect(again.origin).toEqual({ key: "k2", source: "Codex · config.toml", fingerprint: fingerprintOf(roblox.server) });
  });

  it("says when a server changed at its source since it was imported, never by its secret", () => {
    const imported = {
      id: "roblox-studio",
      name: "Roblox_Studio",
      origin: { key: "k2", source: "Codex · config.toml", fingerprint: fingerprintOf(roblox.server) },
    } as McpServerConfig;
    expect(describeFinding(roblox, [imported])).toMatchObject({ imported: true, changed: false });
    // A new key value is not a change the window can see or be told about...
    const rotated = { ...roblox, server: { ...roblox.server, env: { ...roblox.server.env, ROBLOX_API_KEY: "other" } } };
    expect(describeFinding(rotated, [imported]).changed).toBe(false);
    // ...a different command or variable is.
    const moved = { ...roblox, server: { ...roblox.server, env: { MODE: "cloud", ROBLOX_API_KEY: "hidden" } } };
    expect(describeFinding(moved, [imported]).changed).toBe(true);
  });

  it("makes ids from names", () => {
    expect(serverId("Roblox_Studio")).toBe("roblox-studio");
    expect(serverId("  !! ")).toBe("server");
  });
});
