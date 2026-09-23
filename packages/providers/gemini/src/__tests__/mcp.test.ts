import { describe, expect, it } from "vitest";
import { islandExtensionFiles } from "../attention.js";
import { geminiMcpLaunch, MCP_URL_ENV } from "../mcp.js";

describe("connectors for Gemini CLI", () => {
  it("declares the bridge as the extension's MCP server, on every system", () => {
    for (const platform of ["linux", "win32"] as const) {
      const files = islandExtensionFiles(platform);
      const manifest = JSON.parse(files["gemini-extension.json"] ?? "{}") as {
        mcpServers?: Record<string, { command: string; args: string[] }>;
      };
      expect(manifest.mcpServers?.["ai-workbench"]).toEqual({
        command: "node",
        args: ["${extensionPath}${/}mcp-bridge.cjs"],
      });
      expect(files["mcp-bridge.cjs"]).toContain("AI_WORKBENCH_MCP_URL");
    }
  });

  it("names the combined endpoint for the bridge, and nothing without one", () => {
    expect(geminiMcpLaunch([], null, { url: "http://127.0.0.1:9/mcp-all/abc", headers: {} })).toEqual({
      args: [],
      env: { [MCP_URL_ENV]: "http://127.0.0.1:9/mcp-all/abc" },
    });
    expect(geminiMcpLaunch([], null)).toEqual({ args: [], env: {} });
  });
});
