import { join } from "node:path";
import { mkdir } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeTempDirectory, removeTempDirectory } from "@ai-workbench/test-support";
import { createDatabase, runMigrations, type DatabaseHandle } from "@ai-workbench/database";
import type {
  InteractiveLaunch,
  InteractiveLaunchRequest,
  InteractiveTelemetry,
} from "@ai-workbench/provider-base";
import { MockProviderAdapter } from "@ai-workbench/provider-mock";
import type {
  AgentTerminal,
  AppEvent,
  TerminalActivity,
  TerminalAttention,
  TerminalAttentionResponse,
} from "@ai-workbench/shared";
import { AgentTerminalService } from "../agent-terminal-service.js";
import { EventBus } from "../event-bus.js";
import { createNullLogger } from "../logger.js";
import { ProviderManager } from "../provider-manager.js";
import { WorkspaceManager } from "../workspace-manager.js";

/**
 * A terminal agent whose tool reports what it waits on: the service keeps it
 * with the tile, publishes it at once, and passes an answer to the tool only
 * while that very request still waits.
 */

/** Telemetry the test drives by hand, standing in for a tool's own channel. */
class ScriptedTelemetry implements InteractiveTelemetry {
  readonly source = "scripted";
  readonly answers: Array<{ id: string; response: TerminalAttentionResponse }> = [];
  accept = true;
  #onAttention: ((attention: TerminalAttention | null) => void) | null = null;
  #onActivity: ((activity: TerminalActivity | null) => void) | null = null;

  watch(): () => void {
    return () => undefined;
  }

  watchAttention(onAttention: (attention: TerminalAttention | null) => void): () => void {
    this.#onAttention = onAttention;
    return () => {
      this.#onAttention = null;
    };
  }

  watchActivity(onActivity: (activity: TerminalActivity | null) => void): () => void {
    this.#onActivity = onActivity;
    return () => {
      this.#onActivity = null;
    };
  }

  doing(activity: TerminalActivity | null): void {
    this.#onActivity?.(activity);
  }

  async respond(id: string, response: TerminalAttentionResponse): Promise<boolean> {
    this.answers.push({ id, response });
    return this.accept;
  }

  report(attention: TerminalAttention | null): void {
    this.#onAttention?.(attention);
  }
}

class TerminalMockAdapter extends MockProviderAdapter {
  constructor(readonly telemetry: ScriptedTelemetry) {
    super({ chunkDelayMs: 0, startupDelayMs: 0 });
  }

  describeInteractiveLaunch = async (request: InteractiveLaunchRequest): Promise<InteractiveLaunch> => ({
    command: "/bin/true",
    args: [],
    env: {},
    cwd: request.workingDirectory,
    telemetry: this.telemetry,
  });
}

const permission: TerminalAttention = {
  id: "req-1",
  kind: "permission",
  tool: "Bash",
  summary: "touch probe-created.txt",
  choices: [],
  answerable: true,
  since: new Date(1000),
};

describe("terminal agent attention", () => {
  let directory: string;
  let database: DatabaseHandle;
  let telemetry: ScriptedTelemetry;
  let service: AgentTerminalService;
  let published: AgentTerminal[];
  let tile: AgentTerminal;

  beforeEach(async () => {
    directory = await makeTempDirectory("terminal-attention-");
    const logger = createNullLogger();
    database = createDatabase({ file: join(directory, "test.db") });
    await runMigrations(database.client);
    const events = new EventBus();
    published = [];
    events.subscribe((event: AppEvent) => {
      if (event.type === "agentTerminal.changed") {
        published.push(event.terminal);
      }
    });
    const providers = new ProviderManager({ logger, stateDirectory: join(directory, "providers") });
    telemetry = new ScriptedTelemetry();
    await providers.register(new TerminalMockAdapter(telemetry));
    const workspaces = new WorkspaceManager({ db: database.db, events, logger });
    const folder = join(directory, "project");
    await mkdir(folder, { recursive: true });
    const workspace = await workspaces.create({ name: "Project", path: folder });
    let terminals = 0;
    service = new AgentTerminalService({
      db: database.db,
      events,
      logger,
      providers,
      workspaces,
      terminals: {
        create: () => ({ id: `term-${++terminals}` }),
        close: () => true,
        write: () => undefined,
      },
      resolveCommand: (launch) => ({ file: launch.command, args: launch.args, env: launch.env }),
    });
    tile = await service.launch({ workspaceId: workspace.id, providerId: "mock" });
  });

  afterEach(async () => {
    database.client.close();
    await removeTempDirectory(directory);
  });

  /** The tile as the application sees it now. */
  async function current(): Promise<AgentTerminal | undefined> {
    return (await service.list(tile.workspaceId)).find((entry) => entry.id === tile.id);
  }

  /** Lets the service's own publish (it reads the tile first) come through. */
  async function settle(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }

  it("keeps what the tool waits on with the tile and publishes it at once", async () => {
    expect(tile.state).toBe("running");
    expect(tile.attention).toBeNull();

    telemetry.report(permission);
    await settle();
    expect((await current())?.attention).toEqual(permission);
    expect(published.at(-1)?.attention).toEqual(permission);

    telemetry.report(null);
    await settle();
    expect((await current())?.attention).toBeNull();
  });

  it("passes an answer only to the request that still waits, and only one that fits", async () => {
    telemetry.report(permission);
    await settle();

    expect(await service.respond(tile.id, "req-0", { decision: "allow" })).toBe(false);
    expect(await service.respond(tile.id, "req-1", { choice: "0" })).toBe(false);
    expect(telemetry.answers).toEqual([]);

    expect(await service.respond(tile.id, "req-1", { decision: "allow" })).toBe(true);
    expect(telemetry.answers).toEqual([{ id: "req-1", response: { decision: "allow" } }]);
    await settle();
    // Taken: the tile no longer waits, before the tool's next report says so.
    expect((await current())?.attention).toBeNull();
    expect(await service.respond(tile.id, "req-1", { decision: "allow" })).toBe(false);
  });

  it("takes a choice for a question, and nothing for a request only the terminal can answer", async () => {
    telemetry.report({
      ...permission,
      id: "q-1",
      kind: "question",
      tool: "AskUserQuestion",
      summary: "Tea or coffee?",
      choices: [
        { id: "0", label: "Tea" },
        { id: "1", label: "Coffee" },
      ],
    });
    await settle();
    expect(await service.respond(tile.id, "q-1", { choice: "7" })).toBe(false);
    expect(await service.respond(tile.id, "q-1", { decision: "allow" })).toBe(false);
    expect(await service.respond(tile.id, "q-1", { choice: "1" })).toBe(true);

    telemetry.report({ ...permission, id: "plan", tool: "ExitPlanMode", answerable: false });
    await settle();
    expect(await service.respond(tile.id, "plan", { decision: "allow" })).toBe(false);
    expect(telemetry.answers.map((answer) => answer.id)).toEqual(["q-1"]);
  });

  it("keeps waiting when the tool did not take the answer", async () => {
    telemetry.accept = false;
    telemetry.report(permission);
    await settle();
    expect(await service.respond(tile.id, "req-1", { decision: "deny" })).toBe(false);
    expect((await current())?.attention).toEqual(permission);
  });

  it("says working or idle only when the tool said so", async () => {
    // A running process alone is not work.
    expect(tile.activity).toBeNull();

    telemetry.doing({ state: "working", since: new Date(2000) });
    await settle();
    expect((await current())?.activity).toEqual({ state: "working", since: new Date(2000) });

    telemetry.doing({ state: "idle", since: new Date(3000) });
    await settle();
    expect(published.at(-1)?.activity).toEqual({ state: "idle", since: new Date(3000) });

    await service.stop(tile.id);
    expect((await current())?.activity).toBeNull();
  });

  it("waits on nobody once the process ended or was stopped", async () => {
    telemetry.report(permission);
    await settle();
    const terminalId = (await current())?.terminalId;
    expect(terminalId).toBeTruthy();

    service.handleExit(terminalId ?? "", 0);
    await settle();
    expect((await current())?.attention).toBeNull();
    expect(await service.respond(tile.id, "req-1", { decision: "allow" })).toBe(false);

    // A late report from the ended run changes nothing.
    telemetry.report({ ...permission, id: "late" });
    await settle();
    expect((await current())?.attention).toBeNull();
  });
});
