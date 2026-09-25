import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeTempDirectory, removeTempDirectory } from "@ai-workbench/test-support";
import type { CliExtensionContext } from "@ai-workbench/provider-cli";
import { discoverClaudeImportables } from "../importables.js";

const nullLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => nullLogger,
};

describe("what Claude Code keeps that the application can import", () => {
  let directory = "";

  beforeEach(async () => {
    directory = await makeTempDirectory("ai-workbench-claude-importables-");
  });

  afterEach(async () => {
    await removeTempDirectory(directory);
  });

  it("offers a project's shared .mcp.json even when the person's settings never saw the project", async () => {
    // An account home without any .claude.json: a fresh machine, or a
    // project Claude Code was never opened in.
    const home = join(directory, "home");
    const project = join(directory, "project");
    await mkdir(home, { recursive: true });
    await mkdir(project, { recursive: true });
    await writeFile(
      join(project, ".mcp.json"),
      JSON.stringify({ mcpServers: { "project-server": { command: "node", args: ["server.js"] } } }),
    );
    const context = {
      accountHome: home,
      env: {},
      logger: nullLogger,
    } as unknown as CliExtensionContext;

    const found = await discoverClaudeImportables(context, { workspacePath: project });
    const server = found.mcpServers.find((entry) => entry.name === "project-server");
    expect(server?.source).toBe("Claude Code · .mcp.json");
    expect(server?.command).toBe("node");
  });
});
