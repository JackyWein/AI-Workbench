import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeTempDirectory, removeTempDirectory } from "@ai-workbench/test-support";
import { HookState, describeToolInput, type HookDialect } from "../hooks.js";

/**
 * A tool whose hooks can only report that it waits, never answer — the shape
 * Gemini CLI has. Nothing may be answered from outside, and the report ends
 * when the tool moves on.
 */
const reportingDialect: HookDialect = {
  waitEvent: null,
  observeWaiting: (event, body) => {
    if (event !== "Notification") {
      return null;
    }
    const details = (body as { details?: { tool_name?: string; command?: string } }).details;
    return { tool: details?.tool_name ?? "a tool", input: { command: details?.command } };
  },
  toolDone: ["AfterTool"],
  turnStart: ["BeforeAgent"],
  turnEnd: ["AfterAgent", "SessionStart"],
  describe: (id, tool, input, since) => ({
    id,
    kind: "permission",
    tool,
    summary: describeToolInput(input),
    choices: [],
    answerable: true,
    since,
  }),
  answer: () => "should never be asked",
};

describe("hook state for a tool that only reports", () => {
  let directory: string;
  let sequence = 0;

  beforeEach(async () => {
    directory = await makeTempDirectory("hooks-");
  });

  afterEach(async () => {
    await removeTempDirectory(directory);
  });

  /** Writes one event file the way the bridge does, one process id apiece. */
  async function event(name: string, body: unknown): Promise<void> {
    sequence += 1;
    await writeFile(join(directory, `${name}.${4000 + sequence}.json`), JSON.stringify(body));
    // Distinct modification times keep the order the tool wrote them in.
    await new Promise((resolve) => setTimeout(resolve, 15));
  }

  it("shows a reported wait as not answerable, and lets it go when the tool moves on", async () => {
    const state = new HookState(directory, reportingDialect, { alive: () => true });
    await event("BeforeAgent", { prompt: "go" });
    await event("Notification", {
      notification_type: "ToolPermission",
      details: { tool_name: "run_shell_command", command: "rm -rf build" },
    });
    await state.read();

    expect(state.activity?.state).toBe("working");
    expect(state.current).toMatchObject({
      tool: "run_shell_command",
      summary: "rm -rf build",
      answerable: false,
      choices: [],
    });
    // Only the terminal can answer it.
    expect(await state.respond(state.current!.id, { decision: "allow" })).toBe(false);

    await event("AfterTool", { tool_name: "run_shell_command" });
    await state.read();
    expect(state.current).toBeNull();

    await event("AfterAgent", {});
    await state.read();
    expect(state.activity?.state).toBe("idle");
  });

  it("ends a reported wait with the turn, even if the tool never ran", async () => {
    const state = new HookState(directory, reportingDialect, { alive: () => true });
    await event("BeforeAgent", {});
    await event("Notification", { details: { tool_name: "write_file" } });
    await state.read();
    expect(state.current?.tool).toBe("write_file");

    await event("AfterAgent", {});
    await state.read();
    expect(state.current).toBeNull();
  });
});
