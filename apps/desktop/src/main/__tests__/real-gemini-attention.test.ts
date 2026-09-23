import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeTempDirectory, removeTempDirectory } from "@ai-workbench/test-support";
import {
  AgentTerminalService,
  EventBus,
  ProviderManager,
  WorkspaceManager,
  createNullLogger,
} from "@ai-workbench/core";
import { createDatabase, runMigrations, type DatabaseHandle } from "@ai-workbench/database";
import { geminiFactory } from "@ai-workbench/provider-gemini";
import type { AgentTerminal, AppEvent, TerminalAttention } from "@ai-workbench/shared";
import { TerminalManager } from "@ai-workbench/terminal";
import { resolveInteractiveCommand } from "@ai-workbench/transport-cli";

/**
 * The real Gemini CLI, in a real terminal, driven through the application's
 * own terminal agent stack. Only the model is a stand-in: a local server
 * speaking the Gemini API. The island's extension is installed through the
 * application's own setup tile, answering Gemini CLI's own questions there;
 * its hooks, its approval dialog and its transcript are the tool's own.
 *
 * Needs Gemini CLI installed, and no account:
 *
 *   AI_WORKBENCH_REAL_GEMINI=1 [AI_WORKBENCH_GEMINI_PATH=/path/to/gemini] bun run test \
 *     apps/desktop/src/main/__tests__/real-gemini-attention.test.ts
 */
const enabled = process.env["AI_WORKBENCH_REAL_GEMINI"] === "1" && process.platform !== "win32";
const geminiPath = process.env["AI_WORKBENCH_GEMINI_PATH"];

/** Terminal output without escape sequences or any whitespace, for matching. */
function flat(text: string): string {
  // Escape sequences are exactly what is removed here.
  /* eslint-disable no-control-regex */
  return text
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b\][^\x07]*\x07/g, "")
    .replace(/\s+/g, "");
  /* eslint-enable no-control-regex */
}

async function until<T>(
  what: string,
  probe: () => T | null | undefined | false,
  ms = 60_000,
  seen: () => string = () => "",
): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = probe();
    if (value) {
      return value;
    }
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${what}; the terminal ended with: ${seen().slice(-1500)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/**
 * The stand-in model. The latest user text decides: "Just reply" gets words;
 * otherwise, with the shell tool offered, one command, and "done" after its
 * result.
 */
function startStandIn(command: string): Promise<Server> {
  const usage = { promptTokenCount: 12, candidatesTokenCount: 3, totalTokenCount: 15 };
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk: Buffer) => {
      body += chunk.toString("utf8");
    });
    request.on("end", () => {
      const url = request.url ?? "";
      if (url.includes(":countTokens")) {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ totalTokens: 5 }));
        return;
      }
      if (url.includes(":generateContent")) {
        // Gemini CLI's model routing asks which model fits; any answer does.
        response.writeHead(200, { "content-type": "application/json" });
        const routing = { reasoning: "x", model_choice: "flash", complexity_reasoning: "simple", complexity_score: 1 };
        response.end(
          JSON.stringify({
            candidates: [{ content: { role: "model", parts: [{ text: JSON.stringify(routing) }] }, finishReason: "STOP", index: 0 }],
            usageMetadata: usage,
          }),
        );
        return;
      }
      if (!url.includes(":streamGenerateContent")) {
        response.writeHead(200, { "content-type": "application/json" });
        response.end("{}");
        return;
      }
      const parsed = JSON.parse(body || "{}") as {
        contents?: Array<{ role?: string; parts?: Array<{ text?: string; functionResponse?: unknown }> }>;
        tools?: Array<{ functionDeclarations?: Array<{ name?: string }> }>;
      };
      const contents = parsed.contents ?? [];
      const texts = contents.flatMap((content, index) =>
        (content.parts ?? []).flatMap((part) =>
          typeof part.text === "string" && content.role === "user" ? [{ index, text: part.text }] : [],
        ),
      );
      const last = texts.at(-1);
      const prompt = last?.text ?? "";
      const answeredAt = contents.findLastIndex((content) =>
        (content.parts ?? []).some((part) => part.functionResponse !== undefined),
      );
      const answered = answeredAt > (last?.index ?? -1);
      const tools = (parsed.tools ?? []).flatMap((tool) => (tool.functionDeclarations ?? []).map((entry) => entry.name));
      const parts =
        !answered && tools.includes("run_shell_command") && !prompt.includes("Just reply")
          ? [{ functionCall: { name: "run_shell_command", args: { command, description: "Create a file" } } }]
          : [{ text: prompt.includes("Just reply") ? "hello from the stand-in" : "done" }];
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(
        `data: ${JSON.stringify({ candidates: [{ content: { role: "model", parts }, finishReason: "STOP", index: 0 }], usageMetadata: usage })}\r\n\r\n`,
      );
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

describe.runIf(enabled)("real Gemini CLI waiting on the person", () => {
  let directory: string;
  let project: string;
  let database: DatabaseHandle;
  let terminals: TerminalManager;
  let service: AgentTerminalService;
  let providers: ProviderManager;
  let workspaceId: string;
  let standIn: Server;
  const screens = new Map<string, string>();
  let latest = new Map<string, AgentTerminal>();
  const removed = new Set<string>();
  const saved = new Map<string, string | undefined>();
  const setEnv = (key: string, value: string): void => {
    if (!saved.has(key)) {
      saved.set(key, process.env[key]);
    }
    process.env[key] = value;
  };

  beforeEach(async () => {
    directory = await makeTempDirectory("real-gemini-attention-");
    project = join(directory, "project");
    await mkdir(project, { recursive: true });
    standIn = await startStandIn("touch gemini-allowed.txt");
    const port = (standIn.address() as AddressInfo).port;

    // A home of its own: signed in with an API key, and this project trusted,
    // as a person who has used Gemini CLI here before.
    const home = join(directory, "home");
    await mkdir(join(home, ".gemini"), { recursive: true });
    await writeFile(
      join(home, ".gemini", "settings.json"),
      JSON.stringify({
        security: { auth: { selectedType: "gemini-api-key" } },
        general: { disableAutoUpdate: true },
        privacy: { usageStatisticsEnabled: false },
      }),
    );
    await writeFile(join(home, ".gemini", "trustedFolders.json"), JSON.stringify({ [project]: "TRUST_FOLDER" }));
    setEnv("HOME", home);
    setEnv("GEMINI_API_KEY", "standin-key");
    setEnv("GOOGLE_GEMINI_BASE_URL", `http://127.0.0.1:${port}`);
    setEnv("NO_PROXY", "127.0.0.1,localhost");
    setEnv("no_proxy", "127.0.0.1,localhost");

    const logger = createNullLogger();
    database = createDatabase({ file: join(directory, "test.db") });
    await runMigrations(database.client);
    const events = new EventBus();
    latest = new Map();
    events.subscribe((event: AppEvent) => {
      if (event.type === "agentTerminal.changed") {
        latest.set(event.terminal.id, event.terminal);
      }
      if (event.type === "agentTerminal.removed") {
        removed.add(event.id);
      }
    });
    providers = new ProviderManager({ logger, stateDirectory: join(directory, "providers") });
    await providers.registerFactory(geminiFactory(), {
      ...(geminiPath ? { executablePath: geminiPath } : {}),
    });
    const workspaces = new WorkspaceManager({ db: database.db, events, logger });
    workspaceId = (await workspaces.create({ name: "Project", path: project })).id;
    let serviceRef: AgentTerminalService | null = null;
    terminals = new TerminalManager({
      logger,
      onData: (terminalId, chunk) => screens.set(terminalId, (screens.get(terminalId) ?? "") + chunk),
      onExit: (terminalId, exitCode) => serviceRef?.handleExit(terminalId, exitCode),
    });
    service = new AgentTerminalService({
      db: database.db,
      events,
      logger,
      providers,
      workspaces,
      terminals,
      resolveCommand: (launch) => resolveInteractiveCommand(launch),
    });
    serviceRef = service;
  }, 60_000);

  afterEach(async () => {
    service.stopAll();
    database.client.close();
    await new Promise((resolve) => standIn.close(resolve));
    for (const [key, value] of saved) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    saved.clear();
    await removeTempDirectory(directory);
  });

  /**
   * Sets the island up the way a person does: the provider offers it, the
   * setup runs in a tile, and every question Gemini CLI asks there is
   * answered yes.
   */
  async function setUp(): Promise<void> {
    const adapter = providers.get("gemini");
    expect(await adapter?.getIntegration?.()).toMatchObject({ state: "setupNeeded" });
    const tile = await service.startSetup({ workspaceId, providerId: "gemini" });
    const terminalId = tile.terminalId ?? "";
    const screen = (): string => flat(screens.get(terminalId) ?? "");
    let answered = 0;
    await until(
      "the setup to finish",
      () => {
        const questions = (screen().match(/\[y\/N\]|\[Y\/n\]/gi) ?? []).length;
        if (questions > answered) {
          answered = questions;
          terminals.write(terminalId, "y\r");
        }
        return removed.has(tile.id);
      },
      90_000,
      screen,
    );
    expect(answered).toBeGreaterThan(0);
    expect(await adapter?.getIntegration?.()).toMatchObject({ state: "ready" });
  }

  /** Starts Gemini CLI in a tile, waits for its prompt and types into it. */
  async function start(prompt: string): Promise<AgentTerminal> {
    const tile = await service.launch({ workspaceId, providerId: "gemini" });
    const terminalId = tile.terminalId ?? "";
    const screen = (): string => flat(screens.get(terminalId) ?? "");
    const started = Date.now();
    await until(
      "Gemini CLI's prompt",
      () => Date.now() - started > 5000 && /Typeyourmessage/i.test(screen().slice(-2500)),
      60_000,
      screen,
    );
    await new Promise((resolve) => setTimeout(resolve, 1500));
    terminals.write(terminalId, prompt);
    await new Promise((resolve) => setTimeout(resolve, 500));
    terminals.write(terminalId, "\r");
    return tile;
  }

  function waiting(tile: AgentTerminal): TerminalAttention | null {
    return latest.get(tile.id)?.attention ?? null;
  }

  function seen(tile: AgentTerminal): () => string {
    return () => flat(screens.get(tile.terminalId ?? "") ?? "").slice(-1500);
  }

  it("answers a chat turn through the adapter, resumes it, and shows a command it ran", async () => {
    const adapter = providers.get("gemini");
    if (!adapter) {
      throw new Error("Gemini CLI is not registered");
    }
    const info = await adapter.createSession({ sessionId: "chat-1", workingDirectory: project });
    const turn = async (
      providerSessionId: string,
      text: string,
      permissionMode?: "full",
    ): Promise<{ text: string; session: string | null; errors: string[]; tools: string[]; inputTokens: number }> => {
      let answer = "";
      let session: string | null = null;
      let inputTokens = 0;
      const errors: string[] = [];
      const tools: string[] = [];
      for await (const event of adapter.sendMessage(
        { sessionId: "chat-1", providerSessionId, ...(permissionMode ? { permissionMode } : {}) },
        { text },
      )) {
        if (event.type === "text_delta" || event.type === "message") answer += event.text;
        if (event.type === "session") session = event.providerSessionId;
        if (event.type === "error") errors.push(event.error.detail ?? event.error.message);
        if (event.type === "tool_result") tools.push(JSON.stringify(event.toolCall));
        if (event.type === "usage") inputTokens = event.usage.inputTokens ?? 0;
      }
      return { text: answer, session, errors, tools, inputTokens };
    };
    const first = await turn(info.providerSessionId, "Just reply please.");
    expect(first.errors).toEqual([]);
    expect(first.text).toBe("hello from the stand-in");
    expect(first.session).toMatch(/^[0-9a-f-]{36}$/);
    expect(first.inputTokens).toBeGreaterThan(0);
    const second = await turn(first.session ?? "", "Just reply again.");
    expect(second.text).toBe("hello from the stand-in");
    expect(second.session).toBe(first.session);

    // "Full" is Gemini CLI's own yolo mode: the command runs without asking.
    const ran = await turn(first.session ?? "", "Create the file.", "full");
    expect(ran.tools.join()).toContain("touch gemini-allowed.txt");
    expect(ran.text).toBe("done");
    expect(existsSync(join(project, "gemini-allowed.txt"))).toBe(true);
  }, 120_000);

  it("is set up once, then runs a command after Allow from outside, and says when it works and rests", async () => {
    await setUp();
    const tile = await start("Create the file please");
    const attention = await until("the permission request", () => waiting(tile), 60_000, seen(tile));
    expect(attention).toMatchObject({
      kind: "permission",
      tool: "Shell",
      summary: "touch gemini-allowed.txt",
      answerable: true,
    });
    expect(latest.get(tile.id)?.activity?.state).toBe("working");

    expect(await service.respond(tile.id, attention.id, { decision: "allow" })).toBe(true);
    await until("the command to run", () => existsSync(join(project, "gemini-allowed.txt")));
    await until("the turn to end", () => latest.get(tile.id)?.activity?.state === "idle");
    expect(waiting(tile)).toBeNull();
    await until("the session's numbers", () => (latest.get(tile.id)?.metrics?.tokens?.input ?? 0) > 0);
    expect(latest.get(tile.id)?.metrics).toMatchObject({ source: "Gemini CLI session transcript" });
  }, 240_000);

  it("does not run a command after Deny, and rests once Gemini CLI records the refusal", async () => {
    await setUp();
    const tile = await start("Create the file please");
    const attention = await until("the permission request", () => waiting(tile), 60_000, seen(tile));
    expect(await service.respond(tile.id, attention.id, { decision: "deny" })).toBe(true);
    await until("the turn to end", () => latest.get(tile.id)?.activity?.state === "idle", 60_000, seen(tile));
    expect(waiting(tile)).toBeNull();
    expect(existsSync(join(project, "gemini-allowed.txt"))).toBe(false);
  }, 240_000);
});
