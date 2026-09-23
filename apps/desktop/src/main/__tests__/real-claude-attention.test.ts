import { existsSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
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
import { claudeCodeFactory } from "@ai-workbench/provider-claude";
import type { AgentTerminal, AppEvent, TerminalAttention } from "@ai-workbench/shared";
import { TerminalManager } from "@ai-workbench/terminal";
import { resolveInteractiveCommand } from "@ai-workbench/transport-cli";

/**
 * The real Claude Code, in a real terminal, driven through the application's
 * own terminal agent stack: it asks for a permission or puts a question, the
 * application learns of it through Claude Code's hooks, and answers it from
 * outside the terminal — the way the island does.
 *
 * Skipped by default: it spends real quota (spec §113). Run it deliberately,
 * with Claude Code installed and signed in:
 *
 *   AI_WORKBENCH_REAL_PROVIDER=1 bun run test apps/desktop/src/main/__tests__/real-claude-attention.test.ts
 *
 * Each prompt is one small request to the smallest model.
 */
const enabled = process.env["AI_WORKBENCH_REAL_PROVIDER"] === "1" && process.platform !== "win32";

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
  ms = 90_000,
  seen: () => string = () => "",
): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = probe();
    if (value) {
      return value;
    }
    if (Date.now() > deadline) {
      // What the terminal showed, so a failure says where it stopped.
      throw new Error(`timed out waiting for ${what}; the terminal ended with: ${seen().slice(-600)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

describe.runIf(enabled)("real Claude Code waiting on the person", () => {
  let directory: string;
  let project: string;
  let database: DatabaseHandle;
  let terminals: TerminalManager;
  let service: AgentTerminalService;
  let workspaceId: string;
  const screens = new Map<string, string>();
  let latest = new Map<string, AgentTerminal>();

  beforeEach(async () => {
    directory = await makeTempDirectory("real-claude-attention-");
    project = join(directory, "project");
    await mkdir(project, { recursive: true });
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
    const providers = new ProviderManager({ logger, stateDirectory: join(directory, "providers") });
    await providers.registerFactory(claudeCodeFactory());
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
    await removeTempDirectory(directory);
  });

  /** Starts Claude Code in a tile and types a prompt, as a person would. */
  async function start(prompt: string): Promise<AgentTerminal> {
    const tile = await service.launch({ workspaceId, providerId: "claude-code", modelId: "haiku" });
    const terminalId = tile.terminalId ?? "";
    // A new folder: Claude Code first asks whether to trust it, with "No,
    // exit" chosen. That is the person's call in the tile; here the test
    // takes the other answer, once.
    let trusted = false;
    await until(
      "Claude Code's prompt",
      () => {
        const screen = flat(screens.get(terminalId) ?? "");
        if (!trusted && /Yes,Itrustthisfolder/i.test(screen.slice(-3000))) {
          trusted = true;
          // Keys sent while the dialog still settles are lost to its reset.
          setTimeout(() => terminals.write(terminalId, "\x1b[B"), 1500);
          setTimeout(() => terminals.write(terminalId, "\r"), 2300);
          return false;
        }
        // The footer under Claude Code's prompt box.
        return /(forshortcuts|foragents)/i.test(screen.slice(-2000));
      },
      90_000,
      () => flat(screens.get(terminalId) ?? ""),
    );
    // Started and waiting for a prompt: idle, as the tool reported.
    await until("the session to start", () => latest.get(tile.id)?.activity?.state === "idle", 30_000);
    terminals.write(terminalId, prompt);
    await new Promise((resolve) => setTimeout(resolve, 150));
    terminals.write(terminalId, "\r");
    return tile;
  }

  function waiting(tile: AgentTerminal): TerminalAttention | null {
    return latest.get(tile.id)?.attention ?? null;
  }

  it("runs a command after Allow from outside the terminal, and says when it works and rests", async () => {
    const tile = await start(
      "Use the Bash tool to run exactly this command and nothing else: touch allowed.txt . Then reply with the single word done.",
    );
    const attention = await until("the permission request", () => waiting(tile));
    expect(attention).toMatchObject({ kind: "permission", tool: "Bash", answerable: true });
    expect(attention.summary).toContain("touch allowed.txt");
    // Mid-turn: working, reported by the tool itself.
    expect(latest.get(tile.id)?.activity?.state).toBe("working");

    expect(await service.respond(tile.id, attention.id, { decision: "allow" })).toBe(true);
    await until("the command to run", () => existsSync(join(project, "allowed.txt")), 60_000);
    // The turn ends: idle at its prompt.
    await until("the turn to end", () => latest.get(tile.id)?.activity?.state === "idle", 60_000);
  }, 180_000);

  it("rests again after the person interrupts a turn, which no hook reports", async () => {
    const tile = await start("Write a 400-word story about a lighthouse keeper. Do not use any tools.");
    await until("the turn to start", () => latest.get(tile.id)?.activity?.state === "working", 30_000);
    await new Promise((resolve) => setTimeout(resolve, 1500));
    // Esc in the terminal, as the person would press it.
    terminals.write(tile.terminalId ?? "", "\x1b");
    await until("the interrupted turn to rest", () => latest.get(tile.id)?.activity?.state === "idle", 30_000);
  }, 120_000);

  it("does not run a command after Deny from outside the terminal", async () => {
    const tile = await start(
      "Use the Bash tool to run exactly this command and nothing else: touch denied.txt . If it is denied, reply with the single word stopped and do nothing else.",
    );
    const attention = await until("the permission request", () => waiting(tile));
    expect(await service.respond(tile.id, attention.id, { decision: "deny" })).toBe(true);
    // Claude Code says it was denied and carries on without running it.
    await until("Claude to answer", () => /stopped/i.test(flat(screens.get(tile.terminalId ?? "") ?? "").slice(-3000)), 60_000);
    expect(existsSync(join(project, "denied.txt"))).toBe(false);
  }, 180_000);

  it("takes the answer to a question, then a permission, from outside the terminal", async () => {
    const tile = await start(
      "Use the AskUserQuestion tool to ask me exactly one question, 'Tea or coffee?', with exactly the options Tea and Coffee. Then use the Bash tool to run exactly: echo <my answer> > choice.txt (with my answer in place of <my answer>). Then reply with the single word done.",
    );
    const question = await until("the question", () => {
      const attention = waiting(tile);
      return attention?.kind === "question" ? attention : null;
    });
    expect(question.answerable).toBe(true);
    const coffee = question.choices.find((choice) => choice.label === "Coffee");
    expect(coffee).toBeDefined();
    expect(await service.respond(tile.id, question.id, { choice: coffee?.id ?? "" })).toBe(true);

    const permission = await until("the permission request", () => {
      const attention = waiting(tile);
      return attention?.kind === "permission" ? attention : null;
    });
    expect(permission.summary).toContain("choice.txt");
    expect(await service.respond(tile.id, permission.id, { decision: "allow" })).toBe(true);
    await until("the answer to be written", () => existsSync(join(project, "choice.txt")), 60_000);
    expect((await readFile(join(project, "choice.txt"), "utf8")).trim()).toBe("Coffee");
  }, 240_000);
});
