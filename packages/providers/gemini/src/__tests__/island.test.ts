import { copyFile, mkdir, readFile, readdir, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HookState, type CliExtensionContext } from "@ai-workbench/provider-cli";
import { makeTempDirectory, removeTempDirectory } from "@ai-workbench/test-support";
import {
  ISLAND_EXTENSION,
  ISLAND_EXTENSION_VERSION,
  geminiDialect,
  islandExtensionFiles,
  islandIntegration,
  islandSetupArgs,
  metricsFromTranscript,
  parseGeminiLine,
} from "../index.js";

const fixtures = new URL("./fixtures/", import.meta.url);
const fixture = (name: string): Promise<string> => readFile(new URL(name, fixtures), "utf8");

describe("Gemini CLI's headless stream", () => {
  it("reads a recorded turn with a tool call: session, call and result, answer, usage", async () => {
    const state = { values: new Map<string, unknown>() };
    const events = (await fixture("stream-tool.jsonl"))
      .trim()
      .split("\n")
      .flatMap((line) => parseGeminiLine(line, state));
    expect(events[0]).toMatchObject({ type: "session", resumable: true });
    expect(events.find((event) => event.type === "tool_result")).toMatchObject({
      toolCall: {
        name: "run_shell_command",
        summary: "touch gemini-allowed.txt",
        state: "completed",
      },
    });
    expect(events.filter((event) => event.type === "text_delta")).toEqual([
      { type: "text_delta", text: "done" },
    ]);
    expect(events.find((event) => event.type === "usage")).toMatchObject({
      usage: { inputTokens: 36, outputTokens: 9, cacheReadTokens: 0 },
    });
    // The prompt Gemini CLI echoes back is not part of the answer.
    expect(events.some((event) => event.type === "text_delta" && event.text.includes("Create"))).toBe(
      false,
    );
  });
});

describe("Gemini CLI's hooks through the island extension", () => {
  let directory: string;
  beforeEach(async () => {
    directory = await makeTempDirectory("gemini-hooks-");
  });
  afterEach(async () => {
    await removeTempDirectory(directory);
  });

  /** Hands recorded hook reports to the state in the order they were written. */
  async function deliver(names: string[]): Promise<void> {
    for (const name of names) {
      const target = join(directory, name);
      await copyFile(new URL(`hooks-allow/${name}`, fixtures), target);
      const body = JSON.parse(await readFile(target, "utf8")) as { timestamp: string };
      const at = new Date(body.timestamp);
      await utimes(target, at, at);
    }
  }

  it("shows a shell command waiting, says it works, and lets go once it ran", async () => {
    const recorded = (await readdir(new URL("hooks-allow/", fixtures))).sort(
      (a, b) => Number(a.split(".")[1]) - Number(b.split(".")[1]),
    );
    const upTo = (event: string): string[] => recorded.slice(0, recorded.findIndex((name) => name.startsWith(event)) + 1);
    const state = new HookState(directory, geminiDialect);

    await deliver(upTo("Notification"));
    await state.read();
    expect(state.current).toMatchObject({
      kind: "permission",
      tool: "Shell",
      summary: "touch gemini-allowed.txt",
      answerable: true,
    });
    expect(state.activity?.state).toBe("working");
    expect(state.transcriptPath).toMatch(/chats\/session-.*\.jsonl$/);

    await deliver(recorded.filter((name) => !upTo("Notification").includes(name)));
    await state.read();
    expect(state.current).toBeNull();
    expect(state.activity?.state).toBe("idle");
  });

  it("answers the dialog with its own keys: 1 allows once, Esc refuses", () => {
    const request = {
      attention: {
        id: "1",
        kind: "permission" as const,
        tool: "Shell",
        summary: "ls",
        choices: [],
        answerable: true,
        since: new Date(0),
      },
      tool: "run_shell_command",
      input: { command: "ls" },
    };
    expect(geminiDialect.answer(request, { decision: "allow" })).toBe("1");
    expect(geminiDialect.answer(request, { decision: "deny" })).toBe("\u001b");
  });

  it("takes a refused or interrupted turn from the transcript as ended", async () => {
    const lines = (await fixture("transcript-cancelled.jsonl")).trim().split("\n");
    const cancelled = lines.map((line) => JSON.parse(line) as unknown).filter((record) => geminiDialect.endsTurn?.(record));
    expect(cancelled).toHaveLength(1);
  });

  it("only takes tool permission notifications as a request", () => {
    expect(geminiDialect.permissionOf?.({ notification_type: "Other" }, null)).toBeNull();
    expect(
      geminiDialect.permissionOf?.(
        { notification_type: "ToolPermission", details: { type: "exec", command: "ls" } },
        null,
      ),
    ).toEqual({ tool: "run_shell_command", input: { type: "exec", command: "ls" } });
  });
});

describe("Gemini CLI's session transcript", () => {
  it("sums the answers of a recorded session, each once", async () => {
    // Two answers (the tool call, then "done"); Gemini CLI wrote the first
    // one twice under the same id.
    const metrics = metricsFromTranscript(await fixture("transcript-allow.jsonl"), new Date(0));
    expect(metrics).toMatchObject({
      source: "Gemini CLI session transcript",
      providerSessionId: "270c2e64-e746-4f46-908e-8d7474f50b1a",
      tokens: { input: 24, output: 6, cacheRead: 0, reasoning: 0 },
    });
  });

  it("says nothing for a transcript without answers", () => {
    expect(metricsFromTranscript('{"sessionId":"x"}\n', new Date(0))).toBeNull();
  });
});

describe("the island extension", () => {
  let home: string;
  let state: string;
  beforeEach(async () => {
    home = await makeTempDirectory("gemini-home-");
    state = await makeTempDirectory("gemini-state-");
  });
  afterEach(async () => {
    await removeTempDirectory(home);
    await removeTempDirectory(state);
  });

  const context = (): CliExtensionContext =>
    ({
      env: { GEMINI_CLI_HOME: home },
      stateDirectory: state,
      locate: () => Promise.resolve("/usr/bin/gemini"),
    }) as unknown as CliExtensionContext;

  it("carries every hook, with the bridge beside it", () => {
    const posix = islandExtensionFiles("linux");
    const hooks = JSON.parse(posix[join("hooks", "hooks.json")] ?? "{}") as {
      hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>>;
    };
    expect(Object.keys(hooks.hooks)).toEqual(
      expect.arrayContaining(["BeforeAgent", "AfterAgent", "BeforeTool", "Notification"]),
    );
    expect(hooks.hooks["Notification"]?.[0]?.hooks[0]?.command).toBe(
      "/bin/sh '${extensionPath}${/}hook-bridge.sh' Notification observe",
    );
    expect(posix["hook-bridge.sh"]).toContain("AI_WORKBENCH_HOOK_DIR");
    expect(Object.keys(islandExtensionFiles("win32"))).toContain("hook-bridge.ps1");
  });

  it("is offered until Gemini CLI has it installed, current and on", async () => {
    expect(await islandIntegration(context())).toMatchObject({ state: "setupNeeded" });
    const args = await islandSetupArgs(context());
    expect(args?.slice(0, 2)).toEqual(["extensions", "install"]);
    // Gemini CLI asks the person itself.
    expect(args).not.toContain("--consent");

    const installed = join(home, ".gemini", "extensions", ISLAND_EXTENSION);
    await mkdir(installed, { recursive: true });
    await writeFile(
      join(installed, "gemini-extension.json"),
      JSON.stringify({ name: ISLAND_EXTENSION, version: "0.9.0" }),
    );
    expect(await islandIntegration(context())).toMatchObject({ state: "updateNeeded" });
    expect(await islandSetupArgs(context())).toEqual(["extensions", "update", ISLAND_EXTENSION]);

    await writeFile(
      join(installed, "gemini-extension.json"),
      JSON.stringify({ name: ISLAND_EXTENSION, version: ISLAND_EXTENSION_VERSION }),
    );
    expect(await islandIntegration(context())).toMatchObject({ state: "ready" });
    expect(await islandSetupArgs(context())).toBeNull();

    await writeFile(
      join(home, ".gemini", "extensions", "extension-enablement.json"),
      JSON.stringify({ [ISLAND_EXTENSION]: { overrides: [`!${home}/*`] } }),
    );
    expect(await islandIntegration(context())).toMatchObject({ state: "setupNeeded" });
    expect(await islandSetupArgs(context())).toEqual(["extensions", "enable", ISLAND_EXTENSION]);
  });
});
