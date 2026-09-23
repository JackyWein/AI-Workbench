import { spawn } from "node:child_process";
import { appendFile, mkdir, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeTempDirectory, removeTempDirectory } from "@ai-workbench/test-support";
import { HOOK_DIR_ENV, POSIX_HOOK_SCRIPT, posixHookCommand } from "@ai-workbench/provider-cli";
import {
  ClaudeHookState,
  DENY_MESSAGE,
  PERMISSION_HOOK_TIMEOUT_S,
  attentionOf,
  hookSettings,
  type HookEvent,
} from "../attention.js";

/** A permission request exactly as Claude Code 2.1.280 sent it to a hook. */
const bashRequest = {
  session_id: "f0465e42-a1a0-4b8e-b5d0-65ee76dd0d53",
  transcript_path: "/home/me/.claude/projects/p/f0465e42.jsonl",
  cwd: "/home/me/project",
  prompt_id: "e55984d7-e339-47ec-8c71-210fce1ed4b8",
  permission_mode: "default",
  hook_event_name: "PermissionRequest",
  tool_name: "Bash",
  tool_input: {
    command: "touch probe-created.txt",
    description: "Create a file named probe-created.txt",
  },
  permission_suggestions: [{ type: "setMode", mode: "acceptEdits", destination: "session" }],
};

/** A question, as the same version sent it: one question, two options. */
const questionInput = {
  questions: [
    {
      question: "Tea or coffee?",
      header: "Preference",
      options: [
        { label: "Tea", description: "A warm, steeped beverage made from tea leaves" },
        { label: "Coffee", description: "A brewed beverage made from roasted coffee beans" },
      ],
      multiSelect: false,
    },
  ],
};
const questionRequest = {
  ...bashRequest,
  tool_name: "AskUserQuestion",
  tool_input: questionInput,
};

describe("Claude Code attention", () => {
  it("describes a permission by what it wants to do", () => {
    const attention = attentionOf("1", "Bash", bashRequest.tool_input, new Date(0));
    expect(attention).toEqual({
      id: "1",
      kind: "permission",
      tool: "Bash",
      summary: "touch probe-created.txt",
      choices: [],
      answerable: true,
      since: new Date(0),
    });
    expect(attentionOf("2", "Edit", { file_path: "/p/a.ts", old_string: "x" }, new Date(0)).summary).toBe(
      "/p/a.ts",
    );
  });

  it("offers a single question's options, and leaves bigger forms to the terminal", () => {
    const one = attentionOf("1", "AskUserQuestion", questionInput, new Date(0));
    expect(one).toMatchObject({
      kind: "question",
      summary: "Tea or coffee?",
      answerable: true,
      choices: [
        { id: "0", label: "Tea", hint: "A warm, steeped beverage made from tea leaves" },
        { id: "1", label: "Coffee", hint: "A brewed beverage made from roasted coffee beans" },
      ],
    });

    const two = attentionOf(
      "2",
      "AskUserQuestion",
      { questions: [questionInput.questions[0], { ...questionInput.questions[0], question: "Milk?" }] },
      new Date(0),
    );
    expect(two).toMatchObject({ summary: "Tea or coffee? (+1 more)", answerable: false, choices: [] });

    const many = attentionOf(
      "3",
      "AskUserQuestion",
      { questions: [{ ...questionInput.questions[0], multiSelect: true }] },
      new Date(0),
    );
    expect(many.answerable).toBe(false);

    // Leaving plan mode needs the plan as its answer; only the terminal has it.
    expect(attentionOf("4", "ExitPlanMode", { plan: "..." }, new Date(0)).answerable).toBe(false);
  });

  it("waits only in the permission hook; every other hook reports in the background", () => {
    const hooks = hookSettings((event) => `bridge ${event}`) as Record<
      string,
      Array<{ hooks: Array<Record<string, unknown>> }>
    >;
    const reporting = [
      "PostToolUse",
      "PostToolUseFailure",
      "SessionStart",
      "Stop",
      "StopFailure",
      "UserPromptSubmit",
    ];
    expect(Object.keys(hooks).sort()).toEqual(["PermissionRequest", ...reporting].sort());
    expect(hooks["PermissionRequest"]?.[0]?.hooks[0]).toMatchObject({
      type: "command",
      command: "bridge PermissionRequest",
      timeout: PERMISSION_HOOK_TIMEOUT_S,
    });
    expect(hooks["PermissionRequest"]?.[0]?.hooks[0]?.["async"]).toBeUndefined();
    for (const event of reporting) {
      expect(hooks[event]?.[0]?.hooks[0]).toMatchObject({ async: true });
    }
  });
});

describe.runIf(process.platform !== "win32")("Claude Code hook bridge", () => {
  let directory: string;
  let events: string;
  let script: string;
  const running: Array<ReturnType<typeof spawn>> = [];

  beforeEach(async () => {
    directory = await makeTempDirectory("claude-hooks-");
    // A space in the path on purpose: every path must survive the shell.
    events = join(directory, "run hooks");
    await mkdir(events, { recursive: true });
    script = join(directory, "hook bridge.sh");
    await writeFile(script, POSIX_HOOK_SCRIPT, "utf8");
  });

  afterEach(async () => {
    for (const child of running.splice(0)) {
      child.kill("SIGKILL");
    }
    await removeTempDirectory(directory);
  });

  /** Runs one hook the way Claude Code does: through /bin/sh, input on stdin. */
  function hook(
    event: HookEvent,
    input: unknown,
  ): { readonly pid: number; readonly done: Promise<{ stdout: string; code: number | null }>; kill(): void } {
    const child = spawn(
      "/bin/sh",
      ["-c", posixHookCommand({ script, event, waits: event === "PermissionRequest" })],
      // The run's event directory travels in the environment, as Claude
      // Code hands its own environment to its hooks.
      { env: { ...process.env, [HOOK_DIR_ENV]: events } },
    );
    running.push(child);
    child.stdin.end(JSON.stringify(input));
    let stdout = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    const done = new Promise<{ stdout: string; code: number | null }>((resolve) => {
      child.on("close", (code) => resolve({ stdout, code }));
    });
    return { pid: child.pid ?? 0, done, kill: () => child.kill("SIGTERM") };
  }

  /** Reads until the condition holds, as the application's poll would. */
  async function until(attention: ClaudeHookState, holds: () => boolean): Promise<void> {
    const deadline = Date.now() + 5000;
    while (!holds()) {
      if (Date.now() > deadline) {
        throw new Error("timed out waiting for the hooks");
      }
      await attention.read();
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }

  it("passes an allow from the application to Claude Code in its own format", async () => {
    const attention = new ClaudeHookState(events);
    const request = hook("PermissionRequest", bashRequest);
    await until(attention, () => attention.current !== null);
    expect(attention.current).toMatchObject({
      kind: "permission",
      tool: "Bash",
      summary: "touch probe-created.txt",
      answerable: true,
    });

    expect(await attention.respond(attention.current!.id, { decision: "allow" })).toBe(true);
    const { stdout, code } = await request.done;
    expect(code).toBe(0);
    expect(JSON.parse(stdout)).toEqual({
      hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "allow" } },
    });
    expect(attention.current).toBeNull();
    // The event and answer files are gone; nothing piles up per request.
    expect(await readdir(events)).toEqual([]);
  }, 15_000);

  it("passes a refusal with the reason Claude is told", async () => {
    const attention = new ClaudeHookState(events);
    const request = hook("PermissionRequest", bashRequest);
    await until(attention, () => attention.current !== null);

    // A choice is not an answer to a permission.
    expect(await attention.respond(attention.current!.id, { choice: "0" })).toBe(false);
    expect(await attention.respond(attention.current!.id, { decision: "deny" })).toBe(true);
    expect(JSON.parse((await request.done).stdout)).toEqual({
      hookSpecificOutput: {
        hookEventName: "PermissionRequest",
        decision: { behavior: "deny", message: DENY_MESSAGE },
      },
    });
  }, 15_000);

  it("answers a question with the original input and the chosen label", async () => {
    const attention = new ClaudeHookState(events);
    const request = hook("PermissionRequest", questionRequest);
    await until(attention, () => attention.current !== null);
    expect(attention.current?.kind).toBe("question");

    expect(await attention.respond(attention.current!.id, { decision: "allow" })).toBe(false);
    expect(await attention.respond(attention.current!.id, { choice: "1" })).toBe(true);
    expect(JSON.parse((await request.done).stdout)).toEqual({
      hookSpecificOutput: {
        hookEventName: "PermissionRequest",
        decision: {
          behavior: "allow",
          updatedInput: { ...questionInput, answers: { "Tea or coffee?": "Coffee" } },
        },
      },
    });
  }, 15_000);

  it("lets the hook go without an answer once the tool ran after an allow in the terminal", async () => {
    const attention = new ClaudeHookState(events);
    const request = hook("PermissionRequest", bashRequest);
    await until(attention, () => attention.current !== null);
    const id = attention.current!.id;

    await hook("PostToolUse", { ...bashRequest, hook_event_name: "PostToolUse" }).done;
    await until(attention, () => attention.current === null);
    // No output: Claude Code's own answer stands.
    expect(await request.done).toEqual({ stdout: "", code: 0 });
    expect(await attention.respond(id, { decision: "deny" })).toBe(false);
  }, 15_000);

  it("forgets a request whose hook Claude Code ended after an answer in the terminal", async () => {
    const attention = new ClaudeHookState(events);
    const request = hook("PermissionRequest", bashRequest);
    await until(attention, () => attention.current !== null);
    const id = attention.current!.id;

    // Esc in the terminal: Claude Code ends the waiting hook.
    request.kill();
    await request.done;
    await until(attention, () => attention.current === null);
    expect(await attention.respond(id, { decision: "allow" })).toBe(false);
  }, 15_000);

  it("follows a turn: idle at the start, working after a prompt, idle when it ends", async () => {
    const state = new ClaudeHookState(events);
    const transcript = join(directory, "session.jsonl");
    await writeFile(transcript, "", "utf8");
    const common = { session_id: "s", transcript_path: transcript };
    expect(state.activity).toBeNull();

    await hook("SessionStart", { ...common, hook_event_name: "SessionStart", source: "startup" }).done;
    await until(state, () => state.activity?.state === "idle");

    await hook("UserPromptSubmit", { ...common, hook_event_name: "UserPromptSubmit", prompt: "hi" }).done;
    await until(state, () => state.activity?.state === "working");
    // A subagent finishing is not the end of the session's turn.
    await hook("Stop", { ...common, hook_event_name: "Stop", agent_id: "agent-7" }).done;
    await new Promise((resolve) => setTimeout(resolve, 100));
    await state.read();
    expect(state.activity?.state).toBe("working");

    await hook("StopFailure", { ...common, hook_event_name: "StopFailure" }).done;
    await until(state, () => state.activity?.state === "idle");
  }, 15_000);

  it("notices an interrupted turn, which ends without a hook, in the transcript", async () => {
    const state = new ClaudeHookState(events);
    const transcript = join(directory, "session.jsonl");
    // An earlier interruption in a resumed session says nothing about now.
    const interrupted = (at: string): string =>
      `${JSON.stringify({
        type: "user",
        timestamp: at,
        message: { role: "user", content: [{ type: "text", text: "[Request interrupted by user]" }] },
      })}\n`;
    await writeFile(transcript, interrupted("2026-01-01T00:00:00.000Z"), "utf8");

    await hook("UserPromptSubmit", {
      session_id: "s",
      transcript_path: transcript,
      hook_event_name: "UserPromptSubmit",
      prompt: "write a story",
    }).done;
    await until(state, () => state.activity?.state === "working");
    await state.read();
    expect(state.activity?.state).toBe("working");

    // Esc: Claude Code writes the interruption and fires no hook.
    await appendFile(transcript, interrupted(new Date(Date.now() + 1000).toISOString()), "utf8");
    await until(state, () => state.activity?.state === "idle");
  }, 15_000);

  it("ends the main conversation's requests with its turn, but not a subagent's", async () => {
    const attention = new ClaudeHookState(events);
    const main = hook("PermissionRequest", bashRequest);
    await until(attention, () => attention.current !== null);
    const sub = hook("PermissionRequest", { ...bashRequest, agent_id: "agent-7", tool_name: "Write" });
    await new Promise((resolve) => setTimeout(resolve, 100));

    await hook("Stop", { session_id: bashRequest.session_id, hook_event_name: "Stop" }).done;
    await until(attention, () => attention.current?.tool === "Write");
    expect(await main.done).toEqual({ stdout: "", code: 0 });

    // Letting go of everything, as when the tile stops, releases the rest.
    await attention.withdrawAll();
    expect(await sub.done).toEqual({ stdout: "", code: 0 });
    expect(attention.current).toBeNull();
  }, 15_000);
});
