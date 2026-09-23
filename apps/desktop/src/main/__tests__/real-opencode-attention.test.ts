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
import { opencodeFactory } from "@ai-workbench/provider-opencode";
import type { AgentTerminal, AppEvent, ModelInfo, TerminalAttention } from "@ai-workbench/shared";
import { TerminalManager } from "@ai-workbench/terminal";
import { execCli, resolveInteractiveCommand } from "@ai-workbench/transport-cli";

/**
 * The real OpenCode, in a real terminal, driven through the application's
 * own terminal agent stack. Only the model is a stand-in: a local server
 * speaking the chat completions API, configured the way a person configures
 * a provider of their own. OpenCode's terminal interface, its server, its
 * permission and question dialogs are the tool's own.
 *
 * Needs OpenCode installed, and no account:
 *
 *   AI_WORKBENCH_REAL_OPENCODE=1 [AI_WORKBENCH_OPENCODE_PATH=/path/to/opencode] bun run test \
 *     apps/desktop/src/main/__tests__/real-opencode-attention.test.ts
 */
const enabled = process.env["AI_WORKBENCH_REAL_OPENCODE"] === "1" && process.platform !== "win32";
const opencodePath = process.env["AI_WORKBENCH_OPENCODE_PATH"];

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
 * The stand-in model. The latest user message decides: "Just reply" gets
 * words, "Ask me" the question tool, "Run echo" a harmless command and
 * anything else `command`; once a tool's result is back it says "done".
 */
function startStandIn(command: string): Promise<Server> {
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk: Buffer) => {
      body += chunk.toString("utf8");
    });
    request.on("end", () => {
      if (!request.url?.includes("/chat/completions")) {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ object: "list", data: [{ id: "standin-model", object: "model" }] }));
        return;
      }
      const parsed = JSON.parse(body || "{}") as {
        model?: string;
        messages?: Array<{ role: string; content: unknown }>;
        tools?: Array<{ function?: { name?: string } }>;
      };
      const messages = parsed.messages ?? [];
      const tools = (parsed.tools ?? []).map((tool) => tool.function?.name);
      const lastUser = messages.map((message) => message.role).lastIndexOf("user");
      const prompt = lastUser >= 0 ? JSON.stringify(messages[lastUser]?.content ?? "") : "";
      const answered = messages.slice(lastUser + 1).some((message) => message.role === "tool");
      let call: { name: string; arguments: unknown } | null = null;
      if (!answered && tools.length > 0 && !prompt.includes("Just reply")) {
        if (prompt.includes("Ask me") && tools.includes("question")) {
          call = {
            name: "question",
            arguments: {
              questions: [
                {
                  question: "Which colour should the button be?",
                  header: "Colour",
                  options: [
                    { label: "Blue", description: "The calm one" },
                    { label: "Green", description: "The fresh one" },
                  ],
                },
              ],
            },
          };
        } else if (tools.includes("bash")) {
          call = {
            name: "bash",
            arguments: {
              command: prompt.includes("Run echo") ? "echo hello-from-opencode" : command,
              description: "Run a command",
            },
          };
        }
      }
      const base = { id: "chatcmpl-1", object: "chat.completion.chunk", created: 1, model: parsed.model };
      const chunk = (delta: unknown, finish: string | null): void => {
        response.write(
          `data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`,
        );
      };
      response.writeHead(200, { "content-type": "text/event-stream" });
      if (call) {
        chunk(
          {
            role: "assistant",
            tool_calls: [
              { index: 0, id: "call_1", type: "function", function: { name: call.name, arguments: JSON.stringify(call.arguments) } },
            ],
          },
          null,
        );
        chunk({}, "tool_calls");
      } else {
        chunk({ role: "assistant", content: prompt.includes("Just reply") ? "hello from the stand-in" : "done" }, null);
        chunk({}, "stop");
      }
      response.write(
        `data: ${JSON.stringify({ ...base, choices: [], usage: { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 } })}\n\n`,
      );
      response.end("data: [DONE]\n\n");
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

describe.runIf(enabled)("real OpenCode waiting on the person", () => {
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
  const saved = new Map<string, string | undefined>();
  const setEnv = (key: string, value: string): void => {
    if (!saved.has(key)) {
      saved.set(key, process.env[key]);
    }
    process.env[key] = value;
  };

  beforeEach(async () => {
    directory = await makeTempDirectory("real-opencode-attention-");
    project = join(directory, "project");
    await mkdir(project, { recursive: true });
    standIn = await startStandIn("touch opencode-allowed.txt");
    const port = (standIn.address() as AddressInfo).port;

    // A home of its own, with the person's configuration: the stand-in as a
    // provider of theirs, and shell commands to be asked about.
    const home = join(directory, "home");
    setEnv("HOME", home);
    setEnv("XDG_CONFIG_HOME", join(home, ".config"));
    setEnv("XDG_DATA_HOME", join(home, ".local", "share"));
    setEnv("XDG_CACHE_HOME", join(home, ".cache"));
    setEnv("XDG_STATE_HOME", join(home, ".local", "state"));
    setEnv("NO_PROXY", "127.0.0.1,localhost");
    setEnv("no_proxy", "127.0.0.1,localhost");
    await mkdir(join(home, ".config", "opencode"), { recursive: true });
    await writeFile(
      join(home, ".config", "opencode", "opencode.json"),
      JSON.stringify({
        provider: {
          standin: {
            npm: "@ai-sdk/openai-compatible",
            name: "Stand-in",
            options: { baseURL: `http://127.0.0.1:${port}/v1`, apiKey: "standin" },
            models: { "standin-model": { name: "Stand-in model" } },
          },
        },
        model: "standin/standin-model",
        small_model: "standin/standin-model",
        permission: { bash: { "*": "ask", "echo *": "allow" } },
        autoupdate: false,
        share: "disabled",
      }),
    );
    // OpenCode sets up its data on its first start, and two processes
    // starting together in a fresh home collide doing it. A person has
    // started OpenCode before; so has this home.
    await execCli({ executablePath: opencodePath ?? "opencode", args: ["models"], timeoutMs: 120_000 });

    const logger = createNullLogger();
    database = createDatabase({ file: join(directory, "test.db") });
    await runMigrations(database.client);
    const events = new EventBus();
    latest = new Map();
    events.subscribe((event: AppEvent) => {
      if (event.type === "agentTerminal.changed") {
        latest.set(event.terminal.id, event.terminal);
      }
    });
    providers = new ProviderManager({ logger, stateDirectory: join(directory, "providers") });
    await providers.registerFactory(opencodeFactory(), {
      ...(opencodePath ? { executablePath: opencodePath } : {}),
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

  /** Starts OpenCode in a tile, waits for its prompt and types into it. */
  async function start(prompt: string): Promise<AgentTerminal> {
    const tile = await service.launch({ workspaceId, providerId: "opencode" });
    const terminalId = tile.terminalId ?? "";
    const screen = (): string => flat(screens.get(terminalId) ?? "");
    const started = Date.now();
    await until(
      "OpenCode's prompt",
      // Its server answering is what says it is ready: it reports idle.
      () => Date.now() - started > 4000 && latest.get(tile.id)?.activity?.state === "idle",
      60_000,
      screen,
    );
    await new Promise((resolve) => setTimeout(resolve, 1500));
    terminals.write(terminalId, prompt);
    await new Promise((resolve) => setTimeout(resolve, 400));
    terminals.write(terminalId, "\r");
    return tile;
  }

  function waiting(tile: AgentTerminal): TerminalAttention | null {
    return latest.get(tile.id)?.attention ?? null;
  }

  function seen(tile: AgentTerminal): () => string {
    return () => flat(screens.get(tile.terminalId ?? "") ?? "").slice(-1500);
  }

  it("lists the models OpenCode can reach, with names and groups", async () => {
    const models: ModelInfo[] = (await providers.get("opencode")?.refreshModels?.()) ?? [];
    // Among the free models OpenCode offers anyone, the person's own
    // provider, last in the list — where a cut-off verbose list would end.
    expect(models).toContainEqual(expect.objectContaining({ id: "opencode/big-pickle", group: "opencode" }));
    // Its name comes from the verbose list, when that got this far.
    const own = models.find((model) => model.id === "standin/standin-model");
    expect(own).toMatchObject({ group: "standin", source: "provider" });
    expect(["Stand-in model", "standin-model"]).toContain(own?.displayName);
    expect(models.some((model) => (model.reasoningEfforts ?? []).length > 0)).toBe(true);
  }, 150_000);

  it("answers a chat turn through the adapter, resumes it, and shows a command it ran", async () => {
    const adapter = providers.get("opencode");
    if (!adapter) {
      throw new Error("OpenCode is not registered");
    }
    const info = await adapter.createSession({
      sessionId: "chat-1",
      workingDirectory: project,
      modelId: "standin/standin-model",
    });
    const turn = async (
      providerSessionId: string,
      text: string,
    ): Promise<{ text: string; session: string | null; errors: string[]; tools: string[]; inputTokens: number }> => {
      let answer = "";
      let session: string | null = null;
      const errors: string[] = [];
      let inputTokens = 0;
      const tools: string[] = [];
      for await (const event of adapter.sendMessage(
        { sessionId: "chat-1", providerSessionId, modelId: "standin/standin-model" },
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
    expect(first.session).toMatch(/^ses_/);
    expect(first.inputTokens).toBe(12);
    const second = await turn(first.session ?? "", "Just reply again.");
    expect(second.text).toBe("hello from the stand-in");
    expect(second.session).toBe(first.session);

    const ran = await turn(first.session ?? "", "Run echo please.");
    expect(ran.tools.join()).toContain("hello-from-opencode");
    expect(ran.text).toBe("done");
    // Two steps: the call, then the answer.
    expect(ran.inputTokens).toBe(24);
  }, 120_000);

  it("runs a command after Allow from outside the terminal, and says when it works and rests", async () => {
    const tile = await start("Create the file please");
    const attention = await until("the permission request", () => waiting(tile), 60_000, seen(tile));
    expect(attention).toMatchObject({
      kind: "permission",
      tool: "Bash",
      summary: "touch opencode-allowed.txt",
      answerable: true,
    });
    expect(latest.get(tile.id)?.activity?.state).toBe("working");

    expect(await service.respond(tile.id, attention.id, { decision: "allow" })).toBe(true);
    await until("the command to run", () => existsSync(join(project, "opencode-allowed.txt")));
    await until("the turn to end", () => latest.get(tile.id)?.activity?.state === "idle");
    expect(waiting(tile)).toBeNull();
    // What the session used, from OpenCode's own server.
    await until("the session's numbers", () => latest.get(tile.id)?.metrics?.tokens?.input === 24);
    expect(latest.get(tile.id)?.metrics).toMatchObject({ source: "OpenCode server", model: "standin-model" });
  }, 180_000);

  it("does not run a command after Deny, and rests", async () => {
    const tile = await start("Create the file please");
    const attention = await until("the permission request", () => waiting(tile), 60_000, seen(tile));
    expect(await service.respond(tile.id, attention.id, { decision: "deny" })).toBe(true);
    await until("the turn to end", () => latest.get(tile.id)?.activity?.state === "idle");
    expect(waiting(tile)).toBeNull();
    expect(existsSync(join(project, "opencode-allowed.txt"))).toBe(false);
  }, 180_000);

  it("takes a question's answer from outside the terminal", async () => {
    const tile = await start("Ask me about the colour");
    const attention = await until("the question", () => waiting(tile), 60_000, seen(tile));
    expect(attention).toMatchObject({ kind: "question", answerable: true });
    expect(attention.choices.map((choice) => choice.label)).toEqual(["Blue", "Green"]);
    expect(await service.respond(tile.id, attention.id, { choice: "1" })).toBe(true);
    await until("the turn to end", () => latest.get(tile.id)?.activity?.state === "idle");
    expect(waiting(tile)).toBeNull();
  }, 180_000);
});
