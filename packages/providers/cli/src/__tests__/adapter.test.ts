import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ProviderEvent } from "@ai-workbench/shared";
import type { ProviderContext } from "@ai-workbench/provider-base";
import { CliProviderAdapter, isPendingSessionId } from "../adapter.js";
import { parseModelLines } from "../models.js";
import { parseProfile, readPath, substitute, type CliProviderProfileInput } from "../profile.js";
import { builtInCliProfiles, claudeCodeProfile } from "../profiles.js";

const fixtures = join(
  import.meta.dirname,
  "../../../transports/cli/src/__tests__/fixtures",
);
const jsonCli = join(fixtures, "json-cli.mjs");
const streamCli = join(fixtures, "stream-cli.mjs");
const argvCli = join(fixtures, "argv-cli.mjs");
const replayCli = join(fixtures, "replay-cli.mjs");
const claudeStream = join(fixtures, "claude-stream.jsonl");

const nullLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => nullLogger,
};

function contextFor(script: string, extra: Record<string, unknown> = {}): ProviderContext {
  return {
    config: {
      id: "test",
      adapterId: "test",
      transport: "cli",
      authType: "cli",
      executablePath: process.execPath,
      arguments: [script],
      ...extra,
    },
    logger: nullLogger,
    stateDirectory: "/tmp/cli-provider-test",
  };
}

/** A profile shaped like a streaming JSON CLI, pointed at the fixture. */
const jsonProfile: CliProviderProfileInput = {
  schemaVersion: 1,
  id: "fixture-json",
  displayName: "Fixture JSON CLI",
  command: "node",
  auth: {
    method: "cli",
    probeArgs: ["--auth-status"],
    authenticatedPattern: "logged in as",
    unauthenticatedPattern: "not logged in",
    loginHint: "Run the login command.",
  },
  capabilities: ["chat", "streaming", "sessionResume", "modelSelection"],
  models: [{ id: "fixture-a", displayName: "Fixture A", isDefault: true }],
  args: [],
  modelArgs: ["--model", "{model}"],
  resumeArgs: ["--resume", "{providerSessionId}"],
  promptVia: "stdin",
  output: {
    format: "json-lines",
    rules: [
      { emit: "session", when: { type: "session" }, valueKey: "session_id" },
      { emit: "status", when: { type: "status" }, valueKey: "status" },
      { emit: "text_delta", when: { type: "delta" }, valueKey: "text" },
      { emit: "error", when: { type: "error" }, valueKey: "message" },
      {
        emit: "usage",
        when: { type: "usage" },
        inputTokensKey: "input_tokens",
        outputTokensKey: "output_tokens",
      },
    ],
  },
};

const textProfile: CliProviderProfileInput = {
  schemaVersion: 1,
  id: "fixture-text",
  displayName: "Fixture text CLI",
  command: "node",
  auth: { method: "none" },
  capabilities: ["chat", "streaming"],
  args: ["--lines", "3"],
  promptVia: "arg",
  promptArgs: [],
  output: { format: "text" },
};

async function adapterFor(
  profile: CliProviderProfileInput,
  script: string,
): Promise<CliProviderAdapter> {
  const adapter = new CliProviderAdapter(parseProfile(profile));
  await adapter.initialize(contextFor(script));
  return adapter;
}

async function collect(stream: AsyncIterable<ProviderEvent>): Promise<ProviderEvent[]> {
  const events: ProviderEvent[] = [];
  for await (const event of stream) {
    events.push(event);
  }
  return events;
}

function textOf(events: ProviderEvent[]): string {
  return events
    .filter((event) => event.type === "text_delta")
    .map((event) => ("text" in event ? event.text : ""))
    .join("");
}

describe("profile helpers", () => {
  it("reads nested and indexed paths", () => {
    const value = { message: { content: [{ text: "hello" }] } };
    expect(readPath(value, "message.content.0.text")).toBe("hello");
    expect(readPath(value, "message.missing.0")).toBeUndefined();
    expect(readPath(null, "a.b")).toBeUndefined();
  });

  it("substitutes placeholders and drops unresolved groups", () => {
    expect(substitute(["--model", "{model}"], { model: "x" })).toEqual(["--model", "x"]);
    expect(substitute(["--resume", "{providerSessionId}"], {})).toBeNull();
    expect(substitute(["--flag"], {})).toEqual(["--flag"]);
  });

  it("accepts every built-in profile", () => {
    for (const profile of builtInCliProfiles) {
      const parsed = parseProfile(profile);
      expect(parsed.schemaVersion).toBe(1);
      expect(parsed.command.length).toBeGreaterThan(0);
      expect(parsed.capabilities).toContain("chat");
    }
  });

  it("marks a profile as unverified unless it was checked against the tool", () => {
    const byId = new Map(
      builtInCliProfiles.map((profile) => [parseProfile(profile).id, parseProfile(profile)]),
    );
    // Verified below against a recorded live stream.
    expect(byId.get("claude-code")?.unverified).toBe(false);
    // Not run against the real tools here, so the UI must say so.
    expect(byId.get("codex")?.unverified).toBe(true);
    expect(byId.get("gemini")?.unverified).toBe(true);
    expect(byId.get("antigravity")?.unverified).toBe(true);
    expect(byId.get("opencode")?.unverified).toBe(true);
  });

  it("rejects a profile that is not valid", () => {
    expect(() => parseProfile({ schemaVersion: 1, id: "x" })).toThrow();
    expect(() =>
      parseProfile({ ...jsonProfile, output: { format: "json-lines", rules: [] } }),
    ).toThrow();
  });
});

describe("CliProviderAdapter with a streaming JSON CLI", () => {
  it("detects installation and reports a version", async () => {
    const adapter = await adapterFor(jsonProfile, jsonCli);
    const installation = await adapter.detectInstallation();

    expect(installation.state).toBe("installed");
    expect(installation.executablePath).toBe(process.execPath);
  });

  it("reports a missing executable without throwing", async () => {
    const adapter = new CliProviderAdapter(
      parseProfile({ ...jsonProfile, command: "definitely-not-installed" }),
    );
    await adapter.initialize({
      config: { id: "t", adapterId: "t", transport: "cli", authType: "cli" },
      logger: nullLogger,
      stateDirectory: "/tmp",
    });

    expect((await adapter.detectInstallation()).state).toBe("notInstalled");
    expect((await adapter.getAuthenticationStatus()).state).toBe("unknown");
  });

  it("maps an authentication probe onto a normalized state", async () => {
    const authenticated = await adapterFor(jsonProfile, jsonCli);
    expect((await authenticated.getAuthenticationStatus()).state).toBe("authenticated");

    const loggedOut = new CliProviderAdapter(parseProfile(jsonProfile));
    await loggedOut.initialize(
      contextFor(jsonCli, { arguments: [jsonCli, "--logged-out"] }),
    );
    const status = await loggedOut.getAuthenticationStatus();
    expect(status.state).toBe("authenticationRequired");
    expect(status.detail).toBe("Run the login command.");
  });

  it("streams normalized events for a turn", async () => {
    const adapter = await adapterFor(jsonProfile, jsonCli);
    const info = await adapter.createSession({
      sessionId: "s1",
      workingDirectory: process.cwd(),
      modelId: "fixture-a",
    });

    expect(isPendingSessionId(info.providerSessionId)).toBe(true);
    expect(info.resumable).toBe(true);

    const events = await collect(
      adapter.sendMessage(
        {
          sessionId: "s1",
          providerSessionId: info.providerSessionId,
          modelId: "fixture-a",
        },
        { text: "hello world" },
      ),
    );

    // The CLI's own session id arrives in the stream and replaces the pending one.
    expect(events).toContainEqual({
      type: "session",
      providerSessionId: "session-abc",
      resumable: true,
    });
    expect(events.some((event) => event.type === "status")).toBe(true);

    // The prompt reached the CLI through stdin, and the selected model was used.
    expect(textOf(events)).toContain("hello world");
    expect(textOf(events)).toContain("fixture-a");

    const usage = events.find((event) => event.type === "usage");
    expect(usage && "usage" in usage ? usage.usage.outputTokens : null).toBe(22);
    expect(events.at(-1)).toEqual({ type: "completed", reason: "finished" });
  });

  it("ignores output that is not valid JSON", async () => {
    const adapter = await adapterFor(jsonProfile, jsonCli);
    const events = await collect(
      adapter.sendMessage(
        { sessionId: "s1", providerSessionId: "pending:s1" },
        { text: "hi" },
      ),
    );
    // The fixture prints a plain-text line in the middle of the stream.
    expect(textOf(events)).not.toContain("this line is not json");
    expect(events.at(-1)).toEqual({ type: "completed", reason: "finished" });
  });

  it("normalizes a provider error and fails the turn", async () => {
    const adapter = await adapterFor(jsonProfile, jsonCli);
    const events = await collect(
      adapter.sendMessage(
        { sessionId: "s1", providerSessionId: "pending:s1" },
        { text: "make it boom" },
      ),
    );

    const error = events.find((event) => event.type === "error");
    expect(error && "error" in error ? error.error.message : "").toContain("refused");
    expect(events.at(-1)).toEqual({ type: "completed", reason: "failed" });
  });

  it("stops a running turn on cancel", async () => {
    const adapter = new CliProviderAdapter(parseProfile(jsonProfile));
    await adapter.initialize(contextFor(jsonCli, { arguments: [jsonCli, "--delay", "40"] }));

    const handle = { sessionId: "s1", providerSessionId: "pending:s1" };
    const events: ProviderEvent[] = [];
    for await (const event of adapter.sendMessage(handle, { text: "a long answer please" })) {
      events.push(event);
      if (events.filter((entry) => entry.type === "text_delta").length === 2) {
        await adapter.cancel(handle);
      }
    }

    expect(events.at(-1)).toEqual({ type: "completed", reason: "cancelled" });
  });

  it("reports a failure to start as a normalized error", async () => {
    const adapter = new CliProviderAdapter(
      parseProfile({ ...jsonProfile, command: "definitely-not-installed" }),
    );
    await adapter.initialize({
      config: { id: "t", adapterId: "t", transport: "cli", authType: "cli" },
      logger: nullLogger,
      stateDirectory: "/tmp",
    });

    const events = await collect(
      adapter.sendMessage(
        { sessionId: "s1", providerSessionId: "pending:s1" },
        { text: "hi" },
      ),
    );
    const error = events.find((event) => event.type === "error");
    expect(error && "error" in error ? error.error.kind : "").toBe("notInstalled");
    expect(events.at(-1)).toEqual({ type: "completed", reason: "failed" });
  });
});

describe("recorded stream from the real Claude Code CLI", () => {
  /**
   * The fixture is a live `claude --print --output-format stream-json --verbose`
   * stream, captured once and sanitized. Replaying it verifies the profile's
   * event mapping against the tool's actual output without a paid call
   * (spec §113: tests must not trigger paid AI calls).
   */
  async function replayAdapter(): Promise<CliProviderAdapter> {
    const adapter = new CliProviderAdapter(parseProfile(claudeCodeProfile));
    await adapter.initialize({
      config: {
        id: "claude-code",
        adapterId: "claude-code",
        transport: "cli",
        authType: "cli",
        executablePath: process.execPath,
        arguments: [replayCli],
        environmentVariables: { REPLAY_FILE: claudeStream },
      },
      logger: nullLogger,
      stateDirectory: "/tmp/cli-provider-test",
    });
    return adapter;
  }

  it("extracts the session id, the answer and real usage", async () => {
    const adapter = await replayAdapter();
    const events = await collect(
      adapter.sendMessage(
        { sessionId: "s1", providerSessionId: "pending:s1" },
        { text: "Reply with exactly: ok" },
      ),
    );

    expect(events).toContainEqual({
      type: "session",
      providerSessionId: "11111111-2222-3333-4444-555555555555",
      resumable: true,
    });

    // The answer arrives as token deltas and is not duplicated by the
    // whole-message events that carry the same text.
    expect(textOf(events)).toBe("ok");

    const usageEvents = events.filter((event) => event.type === "usage");
    const limits = usageEvents.flatMap((event) =>
      "usage" in event ? event.usage.limits : [],
    );
    const fiveHour = limits.find((limit) => limit.id === "five_hour");
    expect(fiveHour?.used).toBe(57);
    expect(fiveHour?.remaining).toBe(43);
    expect(fiveHour?.unit).toBe("percent");
    expect(fiveHour?.resetsAt).toBeInstanceOf(Date);
    expect(limits.find((limit) => limit.id === "seven_day")?.remaining).toBe(93);

    const tokens = usageEvents.find(
      (event) => "usage" in event && event.usage.outputTokens !== undefined,
    );
    expect(tokens && "usage" in tokens ? tokens.usage.outputTokens : null).toBe(38);

    expect(events.at(-1)).toEqual({ type: "completed", reason: "finished" });
  });

  it("serves the usage it observed during the turn", async () => {
    const adapter = await replayAdapter();

    // Before any turn, usage is honestly reported as unavailable.
    const before = await adapter.getUsage?.();
    expect(before?.state).toBe("unavailable");

    await collect(
      adapter.sendMessage(
        { sessionId: "s1", providerSessionId: "pending:s1" },
        { text: "hi" },
      ),
    );

    const after = await adapter.getUsage?.();
    expect(after?.state).toBe("available");
    expect(after?.source).toBe("cli");
    expect(after?.limits.map((limit) => limit.id)).toEqual(["five_hour", "seven_day"]);
  });
});

describe("CliProviderAdapter with a plain text CLI", () => {
  it("turns each output line into a delta", async () => {
    const adapter = await adapterFor(textProfile, streamCli);
    const events = await collect(
      adapter.sendMessage(
        { sessionId: "s1", providerSessionId: "pending:s1" },
        { text: "ignored" },
      ),
    );

    expect(textOf(events)).toBe("line 1\nline 2\nline 3\n");
    expect(events.at(-1)).toEqual({ type: "completed", reason: "finished" });
  });
});

describe("profile-driven model discovery", () => {
  const modelsCli = join(fixtures, "models-cli.mjs");
  const modelsProfile: CliProviderProfileInput = {
    schemaVersion: 1,
    id: "fixture-models",
    displayName: "Fixture models CLI",
    command: "node",
    auth: { method: "none" },
    capabilities: ["chat", "modelSelection"],
    models: [],
    modelsArgs: ["--models"],
    args: [],
    promptVia: "arg",
    promptArgs: ["{prompt}"],
    output: { format: "text" },
  };

  it("parses one model per line, ignoring blanks and duplicates", () => {
    expect(parseModelLines("acme/atlas\n  acme/bolt  \n\nacme/atlas\n")).toEqual([
      { id: "acme/atlas", displayName: "acme/atlas" },
      { id: "acme/bolt", displayName: "acme/bolt" },
    ]);
    expect(parseModelLines("")).toEqual([]);
  });

  it("discovers the tool's models without manual entry", async () => {
    const adapter = await adapterFor(modelsProfile, modelsCli);
    const models = await adapter.refreshModels();
    expect(models.map((model) => model.id)).toEqual(["acme/atlas", "acme/bolt"]);
    expect(models.every((model) => model.source === "provider")).toBe(true);
  });
});

describe("argument assembly", () => {
  const argvProfile = (overrides: Partial<CliProviderProfileInput>): CliProviderProfileInput => ({
    schemaVersion: 1,
    id: "fixture-argv",
    displayName: "Fixture argv",
    command: "node",
    auth: { method: "none" },
    capabilities: ["chat"],
    args: ["run", "--json"],
    modelArgs: ["--model", "{model}"],
    promptVia: "arg",
    promptArgs: ["{prompt}"],
    output: { format: "text" },
    ...overrides,
  });

  async function argvFor(
    profile: CliProviderProfileInput,
    handle: { sessionId: string; providerSessionId: string; modelId?: string },
  ): Promise<string[]> {
    const adapter = await adapterFor(profile, argvCli);
    const events = await collect(adapter.sendMessage(handle, { text: "the prompt" }));
    // The fixture prints only the arguments after its own script path.
    const printed = textOf(events).trim();
    return JSON.parse(printed) as string[];
  }

  it("omits resume arguments on a first turn", async () => {
    const args = await argvFor(
      argvProfile({ resumeArgs: ["--resume", "{providerSessionId}"] }),
      { sessionId: "s1", providerSessionId: "pending:s1", modelId: "m1" },
    );
    expect(args).toEqual(["run", "--json", "--model", "m1", "the prompt"]);
  });

  it("appends resume arguments once the CLI has assigned a session", async () => {
    const args = await argvFor(
      argvProfile({ resumeArgs: ["--resume", "{providerSessionId}"] }),
      { sessionId: "s1", providerSessionId: "real-42" },
    );
    expect(args).toEqual(["run", "--json", "--resume", "real-42", "the prompt"]);
  });

  it("replaces the base arguments when the profile says so", async () => {
    const args = await argvFor(
      argvProfile({
        resumeArgs: ["resume", "{providerSessionId}", "--json"],
        resumeMode: "replace",
      }),
      { sessionId: "s1", providerSessionId: "real-42" },
    );
    expect(args).toEqual(["resume", "real-42", "--json", "the prompt"]);
  });

  it("omits model arguments when no model is selected", async () => {
    const args = await argvFor(argvProfile({}), {
      sessionId: "s1",
      providerSessionId: "pending:s1",
    });
    expect(args).toEqual(["run", "--json", "the prompt"]);
  });
});
