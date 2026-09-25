import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeTempDirectory, removeTempDirectory } from "@ai-workbench/test-support";
import { discoverAntigravityMcpServers } from "../antigravity.js";
import { discoverAppMcpServers } from "../app-mcp-configs.js";
import {
  parseJsonWithComments,
  readJsonMcpServers,
  readOpenCodeMcpServers,
  readVsCodeMcpServers,
} from "../mcp-configs.js";

describe("MCP configurations of other applications", () => {
  let home = "";
  let project = "";

  beforeEach(async () => {
    home = await makeTempDirectory("ai-workbench-apps-home-");
    project = join(home, "project");
    await mkdir(project, { recursive: true });
  });

  afterEach(async () => {
    await removeTempDirectory(home);
  });

  async function put(path: string, content: unknown): Promise<void> {
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, typeof content === "string" ? content : JSON.stringify(content), "utf8");
  }

  it("reads JSON with comments and trailing commas, leaving strings alone", () => {
    expect(
      parseJsonWithComments(`{
        // a comment
        "url": "https://example.com/a//b", /* another */
        "list": [1, 2,],
      }`),
    ).toEqual({ url: "https://example.com/a//b", list: [1, 2] });
  });

  it("reads VS Code's servers, leaving out values it would ask for", () => {
    const servers = readVsCodeMcpServers(
      {
        inputs: [{ id: "token", type: "promptString" }],
        servers: {
          github: { type: "http", url: "https://api.example.com/mcp", headers: { Authorization: "Bearer ${input:token}" } },
          files: { type: "stdio", command: "npx", args: ["-y", "files-mcp"], env: { ROOT: "/data" } },
        },
      },
      "VS Code · this project",
    );
    expect(servers.map((server) => server.name)).toEqual(["github", "files"]);
    expect(servers[0]).toMatchObject({ transport: "http", url: "https://api.example.com/mcp", headers: {} });
    expect(servers[1]).toMatchObject({ transport: "stdio", command: "npx", args: ["-y", "files-mcp"], env: { ROOT: "/data" } });
  });

  it("reads OpenCode's local and remote servers and skips a disabled one", () => {
    const servers = readOpenCodeMcpServers(
      {
        mcp: {
          local: { type: "local", command: ["bun", "x", "tool-mcp"], environment: { API_KEY: "k" } },
          remote: { type: "remote", url: "https://mcp.example.com", headers: { "X-Key": "v" } },
          off: { type: "local", command: ["x"], enabled: false },
        },
      },
      "OpenCode · your servers",
    );
    expect(servers).toEqual([
      { name: "local", source: "OpenCode · your servers", transport: "stdio", command: "bun", args: ["x", "tool-mcp"], env: { API_KEY: "k" }, headers: {} },
      { name: "remote", source: "OpenCode · your servers", transport: "http", args: [], env: {}, url: "https://mcp.example.com", headers: { "X-Key": "v" } },
    ]);
  });

  it("reads a remote server named by serverUrl, as Windsurf and Antigravity write it", () => {
    expect(readJsonMcpServers({ docs: { serverUrl: "https://docs.example.com/mcp" } }, "Windsurf")[0]).toMatchObject({
      transport: "http",
      url: "https://docs.example.com/mcp",
    });
  });

  it("finds Cursor's, VS Code's and Windsurf's servers where each keeps them", async () => {
    await put(join(home, ".cursor", "mcp.json"), { mcpServers: { "cursor-global": { command: "node", args: ["a.js"] } } });
    await put(join(project, ".cursor", "mcp.json"), { mcpServers: { "cursor-project": { command: "node", args: ["b.js"] } } });
    await put(join(project, ".vscode", "mcp.json"), `{
      // VS Code allows comments here
      "servers": { "vscode-project": { "type": "stdio", "command": "node", "args": ["c.js"] } },
    }`);
    await put(join(home, ".config", "Code", "User", "mcp.json"), { servers: { "vscode-user": { command: "node" } } });
    await put(join(home, ".codeium", "windsurf", "mcp_config.json"), { mcpServers: { windsurf: { serverUrl: "https://w.example.com/mcp" } } });

    const found = await discoverAppMcpServers({ home, workspacePath: project, platform: "linux" });
    const byApp = Object.fromEntries(found.map((entry) => [entry.appName, entry.servers.map((server) => server.name)]));
    expect(byApp).toEqual({
      Cursor: ["cursor-global", "cursor-project"],
      "VS Code": ["vscode-user", "vscode-project"],
      Windsurf: ["windsurf"],
    });
  });

  it("finds Antigravity's servers, but not the memory entry the application keeps there", async () => {
    await put(join(home, ".gemini", "config", "mcp_config.json"), {
      mcpServers: {
        "ai-workbench-obsidian-memory": { command: "node", args: ["memory.js"] },
        linear: { serverUrl: "https://mcp.linear.app/sse" },
      },
    });
    expect((await discoverAntigravityMcpServers(home)).map((server) => server.name)).toEqual(["linear"]);
  });
});
