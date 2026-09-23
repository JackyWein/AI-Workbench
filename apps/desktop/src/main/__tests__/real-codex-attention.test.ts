import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
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
import { codexFactory } from "@ai-workbench/provider-codex";
import type { AgentTerminal, AppEvent, TerminalAttention } from "@ai-workbench/shared";
import { TerminalManager } from "@ai-workbench/terminal";
import { resolveInteractiveCommand } from "@ai-workbench/transport-cli";

/**
 * The real Codex CLI, in a real terminal, driven through the application's
 * own terminal agent stack. Only the model is a stand-in: a local server
 * speaking the Responses API that asks, once, to run one command with raised
 * permissions. Everything else — Codex's approval dialog, its hooks, its
 * trust questions — is the tool's own.
 *
 * Needs the Codex CLI installed, and no account or quota:
 *
 *   AI_WORKBENCH_REAL_CODEX=1 [AI_WORKBENCH_CODEX_PATH=/path/to/codex] bun run test \
 *     apps/desktop/src/main/__tests__/real-codex-attention.test.ts
 */
const enabled = process.env["AI_WORKBENCH_REAL_CODEX"] === "1" && process.platform !== "win32";
const codexPath = process.env["AI_WORKBENCH_CODEX_PATH"];

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
 * The stand-in model. The first turn asks to run `command` outside the
 * sandbox, which Codex must ask the person about; once the command's output
 * comes back it says "done".
 */
function startStandIn(command: string): Promise<Server> {
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk: Buffer) => {
      body += chunk.toString("utf8");
    });
    request.on("end", () => {
      if (!request.url?.includes("/responses")) {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ object: "list", data: [] }));
        return;
      }
      const parsed = JSON.parse(body || "{}") as { input?: unknown; tools?: Array<{ name?: string }> };
      const input = JSON.stringify(parsed.input ?? "");
      const answered =
        input.lastIndexOf("function_call_output") >
        Math.max(input.lastIndexOf("Run echo"), input.lastIndexOf("Just reply"), input.lastIndexOf("Create the file"));
      // A chat turn that only asks for words gets words; one that asks for a
      // harmless command gets it run inside the sandbox, without asking.
      // A resumed thread carries its history: the latest request decides.
      const harmless = input.lastIndexOf("Run echo") > input.lastIndexOf("Just reply");
      const wordsOnly = input.lastIndexOf("Just reply") > input.lastIndexOf("Run echo");
      const canRun =
        !wordsOnly && (parsed.tools ?? []).some((tool) => tool.name === "exec_command");
      const item =
        canRun && !answered
          ? {
              type: "function_call",
              id: "fc_1",
              call_id: "call_1",
              name: "exec_command",
              arguments: JSON.stringify(
                harmless
                  ? { cmd: "echo hello-from-codex" }
                  : {
                      cmd: command,
                      sandbox_permissions: "require_escalated",
                      justification: `Run ${command}?`,
                    },
              ),
              status: "completed",
            }
          : {
              type: "message",
              id: "msg_1",
              role: "assistant",
              status: "completed",
              content: [{ type: "output_text", text: "done", annotations: [] }],
            };
      const events = [
        ["response.created", { response: { id: "resp_1", status: "in_progress", output: [] } }],
        ["response.output_item.added", { output_index: 0, item }],
        ["response.output_item.done", { output_index: 0, item }],
        [
          "response.completed",
          {
            response: {
              id: "resp_1",
              status: "completed",
              output: [item],
              usage: {
                input_tokens: 12,
                input_tokens_details: { cached_tokens: 0 },
                output_tokens: 3,
                output_tokens_details: { reasoning_tokens: 0 },
                total_tokens: 15,
              },
            },
          },
        ],
      ] as const;
      response.writeHead(200, { "content-type": "text/event-stream" });
      for (const [type, data] of events) {
        response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
      }
      response.end();
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

describe.runIf(enabled)("real Codex CLI waiting on the person", () => {
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

  beforeEach(async () => {
    directory = await makeTempDirectory("real-codex-attention-");
    project = join(directory, "project");
    await mkdir(project, { recursive: true });
    // A Codex home of its own: first-run questions appear, as for a person.
    process.env["CODEX_HOME"] = join(directory, "codex-home");
    await mkdir(process.env["CODEX_HOME"], { recursive: true });
    process.env["NO_PROXY"] = "127.0.0.1,localhost";
    process.env["no_proxy"] = "127.0.0.1,localhost";
    standIn = await startStandIn("touch codex-allowed.txt");
    const port = (standIn.address() as AddressInfo).port;

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
    await providers.registerFactory(codexFactory(), {
      ...(codexPath ? { executablePath: codexPath } : {}),
      // The stand-in model, through Codex's own configuration overrides.
      arguments: [
        "-c",
        "model_provider=standin",
        "-c",
        `model_providers.standin={name="Stand-in",base_url="http://127.0.0.1:${port}/v1",wire_api="responses",requires_openai_auth=false}`,
        "-c",
        "model=standin-model",
        "-c",
        'approval_policy="on-request"',
      ],
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
    await removeTempDirectory(directory);
  });

  /**
   * Starts Codex in a tile, answers its first-run questions as the person
   * would — trust this folder, trust these hooks — and types a prompt.
   */
  async function start(prompt: string): Promise<AgentTerminal> {
    const tile = await service.launch({ workspaceId, providerId: "codex" });
    const terminalId = tile.terminalId ?? "";
    const screen = (): string => flat(screens.get(terminalId) ?? "");
    let folder = false;
    let hooks = false;
    let hooksAnsweredAt = 0;
    await until(
      "Codex's prompt",
      () => {
        const tail = screen().slice(-4000);
        if (!folder && /Trustthisfolder\?/i.test(tail)) {
          folder = true;
          setTimeout(() => terminals.write(terminalId, "\r"), 1200);
          return false;
        }
        if (!hooks && /Hooksneedreview/i.test(tail)) {
          hooks = true;
          // "Trust all and continue", the second choice.
          setTimeout(() => terminals.write(terminalId, "\x1b[B"), 1200);
          setTimeout(() => {
            terminals.write(terminalId, "\r");
            hooksAnsweredAt = Date.now();
          }, 1800);
          return false;
        }
        // The prompt's placeholder shows behind the dialogs too: only once
        // they are answered does it mean Codex is ready.
        return (
          hooksAnsweredAt > 0 &&
          Date.now() - hooksAnsweredAt > 2000 &&
          /AskCodextodoanything/i.test(tail.slice(-600))
        );
      },
      60_000,
      screen,
    );
    await new Promise((resolve) => setTimeout(resolve, 1500));
    terminals.write(terminalId, prompt);
    await new Promise((resolve) => setTimeout(resolve, 300));
    terminals.write(terminalId, "\r");
    return tile;
  }

  function waiting(tile: AgentTerminal): TerminalAttention | null {
    return latest.get(tile.id)?.attention ?? null;
  }

  it("lists Codex's own models through the adapter, without an account", async () => {
    const adapter = providers.get("codex");
    const models = await until("the models", () => {
      void adapter?.listModels().then((list) => {
        found = list;
      });
      return found.length > 0 ? found : null;
    });
    expect(models.every((model) => model.source === "provider")).toBe(true);
    expect(models.some((model) => (model.reasoningEfforts ?? []).length > 0)).toBe(true);
  }, 90_000);
  let found: Array<{ source?: string; reasoningEfforts?: string[] }> = [];

  /** What the tile showed and what its hooks wrote, when a wait fails. */
  function seen(tile: AgentTerminal): () => string {
    return () => {
      return flat(screens.get(tile.terminalId ?? "") ?? "").slice(-1500);
    };
  }

  it("answers a chat turn through the adapter, and names the session to resume", async () => {
    const adapter = providers.get("codex");
    if (!adapter) {
      throw new Error("Codex is not registered");
    }
    const info = await adapter.createSession({
      sessionId: "chat-1",
      workingDirectory: project,
      modelId: "standin-model",
    });
    const turn = async (providerSessionId: string): Promise<{ text: string; session: string | null; failed: boolean }> => {
      let text = "";
      let session: string | null = null;
      let failed = false;
      for await (const event of adapter.sendMessage(
        { sessionId: "chat-1", providerSessionId, modelId: "standin-model" },
        { text: "Just reply with the single word done." },
      )) {
        if (event.type === "text_delta" || event.type === "message") text += event.text;
        if (event.type === "session") session = event.providerSessionId;
        if (event.type === "error") failed = true;
      }
      return { text, session, failed };
    };
    // The first turn names the thread; the second continues that same one.
    const first = await turn(info.providerSessionId);
    expect(first).toMatchObject({ failed: false });
    expect(first.text).toContain("done");
    expect(first.session).toBeTruthy();
    const second = await turn(first.session ?? "");
    expect(second.failed).toBe(false);
    expect(second.text).toContain("done");
    expect(second.session).toBe(first.session);

    // A turn that runs a command shows it as a tool call with its result.
    const calls = [];
    for await (const event of adapter.sendMessage(
      { sessionId: "chat-1", providerSessionId: first.session ?? "" },
      { text: "Run echo please." },
    )) {
      if (event.type === "tool_call" || event.type === "tool_result") calls.push(event);
    }
    expect(calls.map((event) => event.type)).toContain("tool_call");
    const result = calls.find((event) => event.type === "tool_result");
    expect(JSON.stringify(result)).toContain("hello-from-codex");
  }, 90_000);

  it("runs a command after Allow from outside the terminal, and says when it works and rests", async () => {
    const tile = await start("Create the file please");
    const attention = await until("the permission request", () => waiting(tile), 60_000, seen(tile));
    expect(attention).toMatchObject({ kind: "permission", tool: "Bash", answerable: true });
    expect(attention.summary).toContain("touch codex-allowed.txt");
    expect(latest.get(tile.id)?.activity?.state).toBe("working");

    expect(await service.respond(tile.id, attention.id, { decision: "allow" })).toBe(true);
    await until("the command to run", () => existsSync(join(project, "codex-allowed.txt")));
    await until("the turn to end", () => latest.get(tile.id)?.activity?.state === "idle");
    expect(waiting(tile)).toBeNull();
  }, 180_000);

  it("does not run a command after Deny, and rests after the interrupted turn", async () => {
    const tile = await start("Create the file please");
    const attention = await until("the permission request", () => waiting(tile));
    expect(await service.respond(tile.id, attention.id, { decision: "deny" })).toBe(true);
    // Codex's own "No" interrupts the turn, which its Interrupt hook reports.
    await until("the turn to end", () => latest.get(tile.id)?.activity?.state === "idle");
    expect(existsSync(join(project, "codex-allowed.txt"))).toBe(false);
  }, 180_000);
});
