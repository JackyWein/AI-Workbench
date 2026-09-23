import { utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeTempDirectory, removeTempDirectory } from "@ai-workbench/test-support";
import { HookState, KEY_ANSWER_SETTLE_MS, describeToolInput, type HookDialect } from "../hooks.js";

/**
 * A tool whose hooks can only report that it waits, never answer — the shape
 * Gemini CLI has. Nothing may be answered from outside, and the report ends
 * when the tool moves on.
 */
const reportingDialect: HookDialect = {
  permissionEvent: null,
  answerBy: "hook",
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

/**
 * A tool that shows no dialog while a hook runs — Codex — reports through a
 * hook that returns at once, and is answered with its own dialog's key.
 */
const keysDialect: HookDialect = {
  ...reportingDialect,
  permissionEvent: "PermissionRequest",
  answerBy: "keys",
  observeWaiting: undefined,
  toolDone: ["PostToolUse"],
  turnStart: ["UserPromptSubmit"],
  turnEnd: ["Stop", "Interrupt"],
  answer: (_request, response) =>
    "decision" in response ? (response.decision === "allow" ? "y" : "\u001b") : null,
};

describe("hook state answered with the tool's own keys", () => {
  let directory: string;

  beforeEach(async () => {
    directory = await makeTempDirectory("hooks-keys-");
  });

  afterEach(async () => {
    await removeTempDirectory(directory);
  });

  /** An event file written `ago` milliseconds back, as a hook left it. */
  async function event(name: string, pid: number, body: unknown, ago = 0): Promise<void> {
    const path = join(directory, `${name}.${pid}.json`);
    await writeFile(path, JSON.stringify(body));
    const at = new Date(Date.now() - ago);
    await utimes(path, at, at);
  }

  it("types the dialog's key once the dialog had time to appear", async () => {
    const state = new HookState(directory, keysDialect, { alive: () => false });
    // Long enough ago that the dialog is up; the hook itself is long gone.
    await event("PermissionRequest", 5001, { tool_name: "Bash", tool_input: { command: "touch x" } }, KEY_ANSWER_SETTLE_MS + 500);
    await state.read();
    // A hook that returned at once is no reason to forget the request.
    expect(state.current).toMatchObject({ tool: "Bash", summary: "touch x", answerable: true });

    const typed: string[] = [];
    expect(await state.respond(state.current!.id, { decision: "allow" }, { write: (data) => typed.push(data) })).toBe(true);
    expect(typed).toEqual(["y"]);
    expect(state.current).toBeNull();
  });

  it("types nothing when the person answered in the terminal first", async () => {
    const state = new HookState(directory, keysDialect, { alive: () => false });
    await event("PermissionRequest", 5002, { tool_name: "Bash", tool_input: { command: "touch x" } }, 200);
    await state.read();
    const id = state.current!.id;
    const typed: string[] = [];
    const answering = state.respond(id, { decision: "deny" }, { write: (data) => typed.push(data) });
    // While the answer waits for the dialog, Esc in the terminal ends the turn.
    await event("Interrupt", 5003, {});
    expect(await answering).toBe(false);
    expect(typed).toEqual([]);
  });

  it("cannot answer by keys without the terminal", async () => {
    const state = new HookState(directory, keysDialect, { alive: () => false });
    await event("PermissionRequest", 5004, { tool_name: "Bash", tool_input: {} }, KEY_ANSWER_SETTLE_MS + 500);
    await state.read();
    expect(await state.respond(state.current!.id, { decision: "allow" })).toBe(false);
  });
});
