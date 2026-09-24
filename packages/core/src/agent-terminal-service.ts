import { asc, eq } from "drizzle-orm";
import type { Database } from "@ai-workbench/database";
import { agentTerminals, type AgentTerminalRow } from "@ai-workbench/database";
import type {
  AIProviderAdapter,
  InteractiveLaunch,
  ProviderToolAccess,
} from "@ai-workbench/provider-base";
import {
  launchAgentTerminalInputSchema,
  permissionModeSchema,
  type AgentTerminal,
  type LaunchAgentTerminalInput,
  type Logger,
  type TerminalActivity,
  type TerminalAttention,
  type TerminalAttentionResponse,
  type TerminalMetrics,
  type UpdateAgentTerminalInput,
} from "@ai-workbench/shared";
import { resolveInsideRoot } from "@ai-workbench/workspace-fs";
import type { EventBus } from "./event-bus.js";
import type { McpService } from "./mcp-service.js";
import { createId } from "./ids.js";
import { withServerGuidance } from "./server-guidance.js";
import type { ProviderManager } from "./provider-manager.js";
import type { WorkspaceManager } from "./workspace-manager.js";

/** What the service needs from the terminal backend, and nothing more. */
export interface AgentTerminalHost {
  create(options: {
    readonly sessionId: string;
    readonly cwd: string;
    readonly cols?: number;
    readonly rows?: number;
    /** Arguments as an array, or one command line already quoted for cmd.exe. */
    readonly command?: { readonly file: string; readonly args: readonly string[] | string };
    readonly env?: Record<string, string>;
  }): { readonly id: string };
  close(terminalId: string): boolean;
  /** Types into a running terminal, as the person would. */
  write(terminalId: string, data: string): void;
  /**
   * The dialog the terminal's program shows and waits on (a question with
   * numbered options, one marked), read from its screen; null when none.
   */
  prompt?(terminalId: string): Promise<ScreenDialog | null>;
  /**
   * Picks an option of the dialog on screen with the program's own keys;
   * false when the dialog changed or did not take it.
   */
  choose?(terminalId: string, fingerprint: string, index: number): Promise<boolean>;
}

/** A dialog as a terminal's screen shows it. */
export interface ScreenDialog {
  readonly question: string;
  readonly context: string;
  readonly options: ReadonlyArray<{ readonly number: number; readonly label: string }>;
  readonly fingerprint: string;
}

export interface AgentTerminalServiceOptions {
  readonly db: Database;
  readonly events: EventBus;
  readonly logger: Logger;
  readonly providers: ProviderManager;
  readonly workspaces: WorkspaceManager;
  readonly terminals: AgentTerminalHost;
  /**
   * Turns a provider's launch description into something a terminal can
   * start; on Windows that is where a `.cmd` tool is resolved.
   */
  readonly resolveCommand: (launch: InteractiveLaunch) => {
    readonly file: string;
    readonly args: readonly string[] | string;
    readonly env: Record<string, string>;
  };
  /**
   * The MCP servers an agent in this workspace may use. Without it agents
   * get none — the same as a session with no servers.
   */
  readonly mcp?: Pick<McpService, "enabledForWorkspace" | "toolAccess" | "instructionsFor">;
}

interface Runtime {
  workspaceId: string;
  terminalId: string | null;
  state: AgentTerminal["state"];
  exitCode: number | null;
  detail?: string;
  startedAt: Date | null;
  /** The last numbers the tool reported for this run. */
  metrics: TerminalMetrics | null;
  /** What the tool waits on the person for; null when nothing, or not running. */
  attention: TerminalAttention | null;
  /** Working or idle, as the tool reported; null when it does not say. */
  activity: TerminalActivity | null;
  /** Answers the tool's waiting request; null when the tool takes no answers. */
  respond:
    | ((
        attentionId: string,
        response: TerminalAttentionResponse,
        terminal: { write(data: string): void },
      ) => Promise<boolean>)
    | null;
  /** Stops following the tool's reports; null when nothing is followed. */
  stopTelemetry: (() => void) | null;
  /**
   * A dialog the tool shows on its screen, when its own reports say nothing
   * of it: what the island shows and answers for a tool without hooks.
   */
  screen?: { attention: TerminalAttention; fingerprint: string } | null;
}

/** How long a terminal stays quiet before its screen is read for a dialog. */
const SCREEN_SETTLE_MS = 300;

/** How long a tool may keep writing its final numbers after it exits. */
const TELEMETRY_GRACE_MS = 4000;
/** Metrics of one terminal are published at most this often. */
const METRICS_THROTTLE_MS = 750;

/**
 * Terminal agents (spec §26, §91): each one is a provider's own interactive
 * interface, started with the tool, account, model and effort the person
 * chose, in a real terminal inside the workspace.
 *
 * The runtime is independent of the screen — a tile that is not visible keeps
 * running — and every process is stopped when its tile is removed, its
 * workspace is deleted or the application quits. Nothing names a provider:
 * the adapter describes how its tool starts.
 */
export class AgentTerminalService {
  readonly #db: Database;
  readonly #events: EventBus;
  readonly #logger: Logger;
  readonly #providers: ProviderManager;
  readonly #workspaces: WorkspaceManager;
  readonly #terminals: AgentTerminalHost;
  readonly #resolveCommand: AgentTerminalServiceOptions["resolveCommand"];
  readonly #mcp: AgentTerminalServiceOptions["mcp"];
  readonly #runtime = new Map<string, Runtime>();
  /** Sign-in terminals are not persisted; they live only while they run. */
  readonly #transient = new Map<string, AgentTerminal>();
  readonly #byTerminal = new Map<string, string>();
  /** A pending read of each tile's screen, after its output settles. */
  readonly #screenTimers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(options: AgentTerminalServiceOptions) {
    this.#db = options.db;
    this.#events = options.events;
    this.#logger = options.logger.child("TERMINAL");
    this.#providers = options.providers;
    this.#workspaces = options.workspaces;
    this.#terminals = options.terminals;
    this.#resolveCommand = options.resolveCommand;
    this.#mcp = options.mcp;
  }

  async list(workspaceId: string): Promise<AgentTerminal[]> {
    const rows = await this.#db
      .select()
      .from(agentTerminals)
      .where(eq(agentTerminals.workspaceId, workspaceId))
      .orderBy(asc(agentTerminals.createdAt));
    const persisted = rows.map((row) => this.#compose(row));
    const transient = [...this.#transient.values()].filter(
      (entry) => entry.workspaceId === workspaceId,
    );
    return [...persisted, ...transient];
  }

  /** Creates a tile and starts it. */
  async launch(raw: LaunchAgentTerminalInput): Promise<AgentTerminal> {
    const input = launchAgentTerminalInputSchema.parse(raw);
    const workspace = await this.#workspaces.require(input.workspaceId);
    const workingDirectory = input.workingDirectory
      ? resolveInsideRoot(workspace.path, input.workingDirectory)
      : workspace.path;

    let label = input.label ?? "Terminal";
    if (input.purpose === "agent") {
      if (!input.providerId) {
        throw new Error("Choose a provider for the agent");
      }
      const adapter = this.#providers.get(input.providerId);
      if (!adapter) {
        throw new Error(`Provider "${input.providerId}" is not available`);
      }
      if (!adapter.describeInteractiveLaunch) {
        throw new Error(`${adapter.metadata.displayName} cannot run in a terminal`);
      }
      label =
        input.label ??
        [adapter.metadata.displayName, adapter.metadata.account?.label]
          .filter(Boolean)
          .join(" · ");
    }

    const row: AgentTerminalRow = {
      id: createId("agt"),
      workspaceId: workspace.id,
      purpose: input.purpose,
      providerId: input.purpose === "agent" ? (input.providerId ?? null) : null,
      label,
      modelId: input.modelId ?? null,
      reasoningEffort: input.reasoningEffort ?? null,
      permissionMode: input.permissionMode ?? null,
      workingDirectory,
      createdAt: new Date(),
    };
    await this.#db.insert(agentTerminals).values(row);
    return this.#start(this.#compose(row), { cols: input.cols, rows: input.rows });
  }

  /** Starts a tile again after it stopped or exited. */
  async start(id: string, size: { cols?: number; rows?: number } = {}): Promise<AgentTerminal> {
    const current = await this.#require(id);
    if (current.state === "running") {
      return current;
    }
    return this.#start(current, size);
  }

  /** Stops the process and keeps the tile. */
  async stop(id: string): Promise<AgentTerminal> {
    const current = await this.#require(id);
    const runtime = this.#runtime.get(id);
    if (runtime?.terminalId) {
      this.#byTerminal.delete(runtime.terminalId);
      this.#terminals.close(runtime.terminalId);
    }
    runtime?.stopTelemetry?.();
    const metrics = runtime?.metrics ?? null;
    this.#runtime.set(id, {
      workspaceId: current.workspaceId,
      terminalId: null,
      state: "stopped",
      exitCode: null,
      startedAt: null,
      metrics,
      attention: null,
      activity: null,
      respond: null,
      stopTelemetry: null,
    });
    const next = {
      ...current,
      terminalId: null,
      state: "stopped" as const,
      exitCode: null,
      startedAt: null,
      metrics,
      attention: null,
      activity: null,
    };
    this.#publish(next);
    return next;
  }

  /** Stops the process and removes the tile. */
  async remove(id: string): Promise<boolean> {
    const runtime = this.#runtime.get(id);
    if (runtime?.terminalId) {
      this.#byTerminal.delete(runtime.terminalId);
      this.#terminals.close(runtime.terminalId);
    }
    runtime?.stopTelemetry?.();
    this.#runtime.delete(id);

    const transient = this.#transient.get(id);
    if (transient) {
      this.#transient.delete(id);
      this.#events.publish({ type: "agentTerminal.removed", id, workspaceId: transient.workspaceId });
      return true;
    }

    const [row] = await this.#db.select().from(agentTerminals).where(eq(agentTerminals.id, id)).limit(1);
    if (!row) {
      return false;
    }
    await this.#db.delete(agentTerminals).where(eq(agentTerminals.id, id));
    this.#events.publish({ type: "agentTerminal.removed", id, workspaceId: row.workspaceId });
    return true;
  }

  /** Changes what a tile starts with; applies from its next start. */
  async update(input: UpdateAgentTerminalInput): Promise<AgentTerminal> {
    await this.#require(input.id);
    const set: Partial<AgentTerminalRow> = {};
    if (input.label !== undefined) set.label = input.label;
    if (input.modelId !== undefined) set.modelId = input.modelId;
    if (input.reasoningEffort !== undefined) set.reasoningEffort = input.reasoningEffort;
    if (input.permissionMode !== undefined) set.permissionMode = input.permissionMode;
    if (Object.keys(set).length > 0) {
      await this.#db.update(agentTerminals).set(set).where(eq(agentTerminals.id, input.id));
    }
    const next = await this.#require(input.id);
    this.#publish(next);
    return next;
  }

  /**
   * Answers what a running tile's tool is waiting on — a permission or a
   * question — from outside its terminal. The tool decides whether it takes
   * the answer; its own prompt in the terminal stays usable either way. False
   * when the tile no longer waits on that request or the tool took no answer.
   */
  async respond(
    id: string,
    attentionId: string,
    response: TerminalAttentionResponse,
  ): Promise<boolean> {
    const runtime = this.#runtime.get(id);
    if (!runtime?.attention && runtime?.screen?.attention.id === attentionId) {
      return this.#answerOnScreen(id, runtime, response);
    }
    const attention = runtime?.attention;
    if (
      !runtime?.respond ||
      runtime.state !== "running" ||
      attention?.id !== attentionId ||
      !attention.answerable
    ) {
      return false;
    }
    const fits =
      "decision" in response
        ? attention.kind === "permission"
        : attention.kind === "question" &&
          attention.choices.some((choice) => choice.id === response.choice);
    if (!fits) {
      return false;
    }
    const terminalId = runtime.terminalId;
    if (!terminalId) {
      return false;
    }
    let answered = false;
    try {
      // Some tools take the answer as their own dialog's key, typed into the
      // tile's terminal for the person.
      answered = await runtime.respond(attentionId, response, {
        write: (data) => this.#terminals.write(terminalId, data),
      });
    } catch {
      answered = false;
    }
    this.#logger.info("Answered a terminal agent from outside its terminal", {
      agentTerminalId: id,
      kind: attention.kind,
      answered,
    });
    if (answered && this.#runtime.get(id)?.attention?.id === attentionId) {
      // Taken: it no longer waits, even before the tool's next report says so.
      const current = this.#runtime.get(id);
      if (current) {
        current.attention = null;
      }
      void this.#require(id)
        .then((terminal) => this.#publish(terminal))
        .catch(() => undefined);
    }
    return answered;
  }

  /**
   * Opens the tool's own sign-in for one provider entry in a terminal, so the
   * person signs in with the tool itself (spec §14). The tile disappears once
   * the sign-in ends, and the provider is asked again who is signed in.
   */
  async startLogin(input: {
    readonly workspaceId: string;
    readonly providerId: string;
    readonly cols?: number;
    readonly rows?: number;
  }): Promise<AgentTerminal> {
    const adapter = this.#providers.get(input.providerId);
    const launch = await adapter?.describeLogin?.();
    if (!adapter || !launch) {
      throw new Error("This provider has no sign-in command; sign in with the tool itself");
    }
    return this.#startTransient(input, "login", "Sign in", launch);
  }

  /**
   * Runs a provider's own one-time setup in a terminal, so the person answers
   * the tool's own questions (see ProviderIntegration). The tile goes when the
   * setup ends, and the provider is asked again whether it is set up.
   */
  async startSetup(input: {
    readonly workspaceId: string;
    readonly providerId: string;
    readonly cols?: number;
    readonly rows?: number;
  }): Promise<AgentTerminal> {
    const adapter = this.#providers.get(input.providerId);
    const launch = await adapter?.describeIntegrationSetup?.();
    if (!adapter || !launch) {
      throw new Error("This provider has nothing to set up");
    }
    return this.#startTransient(input, "setup", "Set up", launch);
  }

  async #startTransient(
    input: {
      readonly workspaceId: string;
      readonly providerId: string;
      readonly cols?: number;
      readonly rows?: number;
    },
    purpose: "login" | "setup",
    title: string,
    launch: InteractiveLaunch,
  ): Promise<AgentTerminal> {
    const workspace = await this.#workspaces.require(input.workspaceId);
    const adapter = this.#providers.get(input.providerId);
    const entry: AgentTerminal = {
      id: createId("agt"),
      workspaceId: workspace.id,
      purpose,
      providerId: input.providerId,
      label: `${title} · ${[adapter?.metadata.displayName, adapter?.metadata.account?.label]
        .filter(Boolean)
        .join(" · ")}`,
      modelId: null,
      reasoningEffort: null,
      permissionMode: null,
      workingDirectory: workspace.path,
      terminalId: null,
      state: "stopped",
      exitCode: null,
      startedAt: null,
      metrics: null,
      attention: null,
      activity: null,
      createdAt: new Date(),
    };
    this.#transient.set(entry.id, entry);
    // A sign-in runs in the workspace; a setup where its tool put it.
    return this.#spawn(entry, purpose === "login" ? { ...launch, cwd: workspace.path } : launch, input);
  }

  /** Called by the terminal backend when a process ends. */
  /**
   * The terminal wrote something. Once it has been quiet for a moment its
   * screen is read for a dialog — the way to see a tool wait on the person
   * when its own reports say nothing (a tool without hooks, or hooks that do
   * not run on this machine).
   */
  handleOutput(terminalId: string): void {
    const id = this.#byTerminal.get(terminalId);
    if (!id || !this.#terminals.prompt) {
      return;
    }
    const pending = this.#screenTimers.get(id);
    if (pending) {
      clearTimeout(pending);
    }
    const timer = setTimeout(() => {
      this.#screenTimers.delete(id);
      void this.#readScreen(id, terminalId).catch((error: unknown) =>
        this.#logger.debug("Could not read a terminal's screen", {
          agentTerminalId: id,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    }, SCREEN_SETTLE_MS);
    timer.unref?.();
    this.#screenTimers.set(id, timer);
  }

  async #readScreen(id: string, terminalId: string): Promise<void> {
    const runtime = this.#runtime.get(id);
    if (!runtime || runtime.state !== "running" || runtime.terminalId !== terminalId) {
      return;
    }
    const terminal = await this.#require(id).catch(() => null);
    if (!terminal || terminal.purpose !== "agent") {
      return;
    }
    const dialog = await this.#terminals.prompt?.(terminalId);
    const current = this.#runtime.get(id);
    if (!current || current.terminalId !== terminalId) {
      return;
    }
    const before = current.screen ?? null;
    const next = dialog
      ? {
          fingerprint: dialog.fingerprint,
          attention: {
            // The same dialog keeps its id and its clock while it stays up.
            id: before?.fingerprint === dialog.fingerprint ? before.attention.id : createId("screen"),
            kind: "question" as const,
            summary: (dialog.question || "Waiting for your choice").slice(0, 500),
            ...(dialog.context ? { context: dialog.context.slice(0, 500) } : {}),
            choices: dialog.options.slice(0, 9).map((option, index) => ({
              id: String(index),
              label: option.label.slice(0, 200) || `Option ${option.number}`,
            })),
            answerable: Boolean(this.#terminals.choose),
            since: before?.fingerprint === dialog.fingerprint ? before.attention.since : new Date(),
          },
        }
      : null;
    if (JSON.stringify(next) === JSON.stringify(before)) {
      return;
    }
    current.screen = next;
    if (next && !before) {
      this.#logger.info("A terminal agent waits on a dialog on its screen", {
        agentTerminalId: id,
        options: next.attention.choices.length,
      });
    }
    if (!current.attention) {
      this.#publish(await this.#require(id));
    }
  }

  /** Answers a dialog on the tool's screen by picking the option with its own keys. */
  async #answerOnScreen(id: string, runtime: Runtime, response: TerminalAttentionResponse): Promise<boolean> {
    const screen = runtime.screen;
    const terminalId = runtime.terminalId;
    if (!screen || !terminalId || runtime.state !== "running" || !("choice" in response) || !this.#terminals.choose) {
      return false;
    }
    const index = Number(response.choice);
    if (!Number.isInteger(index) || !screen.attention.choices.some((choice) => choice.id === response.choice)) {
      return false;
    }
    const answered = await this.#terminals.choose(terminalId, screen.fingerprint, index).catch(() => false);
    this.#logger.info("Answered a dialog on a terminal agent's screen", { agentTerminalId: id, answered });
    if (answered) {
      const current = this.#runtime.get(id);
      if (current?.screen?.fingerprint === screen.fingerprint) {
        current.screen = null;
        void this.#require(id)
          .then((terminal) => this.#publish(terminal))
          .catch(() => undefined);
      }
    }
    return answered;
  }

  handleExit(terminalId: string, exitCode: number): void {
    const id = this.#byTerminal.get(terminalId);
    if (!id) {
      return;
    }
    this.#byTerminal.delete(terminalId);
    const runtime = this.#runtime.get(id);
    if (runtime) {
      // A process that ended waits on nobody, whatever its last report said.
      this.#runtime.set(id, {
        ...runtime,
        terminalId: null,
        state: "exited",
        exitCode,
        attention: null,
        activity: null,
        respond: null,
        screen: null,
      });
      // The tool may write its last numbers while it shuts down.
      const stop = runtime.stopTelemetry;
      if (stop) {
        setTimeout(() => {
          stop();
          const current = this.#runtime.get(id);
          if (current?.stopTelemetry === stop) {
            this.#runtime.set(id, { ...current, stopTelemetry: null });
          }
        }, TELEMETRY_GRACE_MS).unref?.();
      }
    }

    const transient = this.#transient.get(id);
    if (transient) {
      // A finished sign-in or setup has done its job: the tile goes, and the
      // provider is asked again who is signed in, or whether it is set up.
      this.#transient.delete(id);
      this.#events.publish({ type: "agentTerminal.removed", id, workspaceId: transient.workspaceId });
      if (transient.providerId) {
        void this.#providers.reinitialize(transient.providerId).catch(() => undefined);
      }
      return;
    }
    void this.#require(id)
      .then((terminal) => this.#publish(terminal))
      .catch(() => undefined);
  }

  /** Stops every process of a workspace, or all of them. */
  stopAll(workspaceId?: string): void {
    for (const [id, runtime] of this.#runtime) {
      if (!runtime.terminalId || (workspaceId && runtime.workspaceId !== workspaceId)) {
        continue;
      }
      this.#byTerminal.delete(runtime.terminalId);
      this.#terminals.close(runtime.terminalId);
      runtime.stopTelemetry?.();
      this.#runtime.set(id, {
        ...runtime,
        terminalId: null,
        state: "stopped",
        attention: null,
        activity: null,
        respond: null,
        stopTelemetry: null,
      });
    }
  }

  async #start(
    terminal: AgentTerminal,
    size: { cols?: number | undefined; rows?: number | undefined },
  ): Promise<AgentTerminal> {
    if (terminal.purpose === "shell") {
      return this.#spawn(terminal, null, size);
    }
    const adapter = terminal.providerId ? this.#providers.get(terminal.providerId) : undefined;
    if (!adapter?.describeInteractiveLaunch) {
      return this.#fail(terminal, "The provider of this agent is not available");
    }
    let launch: InteractiveLaunch;
    try {
      const toolAccess = await this.#toolAccess(terminal.workspaceId, adapter);
      // A terminal agent is told what its servers are for, like a chat is.
      const mcp = this.#mcp;
      const systemInstructions = withServerGuidance(
        undefined,
        toolAccess,
        mcp ? (ids) => mcp.instructionsFor(ids) : undefined,
      );
      launch = await adapter.describeInteractiveLaunch({
        workingDirectory: terminal.workingDirectory,
        ...(toolAccess ? { toolAccess } : {}),
        ...(systemInstructions ? { systemInstructions } : {}),
        runId: `${terminal.id}-${Date.now().toString(36)}`,
        startedAt: new Date(),
        ...(terminal.modelId ? { modelId: terminal.modelId } : {}),
        ...(terminal.reasoningEffort ? { reasoningEffort: terminal.reasoningEffort } : {}),
        ...(terminal.permissionMode ? { permissionMode: terminal.permissionMode } : {}),
      });
    } catch (error) {
      return this.#fail(terminal, error instanceof Error ? error.message : String(error));
    }
    return this.#spawn(terminal, launch, size);
  }

  /** The servers the agent may use, as its provider takes them; none when that fails. */
  async #toolAccess(
    workspaceId: string,
    adapter: AIProviderAdapter,
  ): Promise<ProviderToolAccess | null> {
    if (!this.#mcp) {
      return null;
    }
    try {
      const capabilities = await adapter.getCapabilities();
      return await this.#mcp.toolAccess(capabilities, await this.#mcp.enabledForWorkspace(workspaceId));
    } catch (error) {
      this.#logger.warn("MCP servers could not be resolved for an agent", {
        workspaceId,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  #spawn(
    terminal: AgentTerminal,
    launch: InteractiveLaunch | null,
    size: { cols?: number | undefined; rows?: number | undefined },
  ): AgentTerminal {
    try {
      const resolved = launch ? this.#resolveCommand(launch) : null;
      const created = this.#terminals.create({
        sessionId: `agent:${terminal.id}`,
        cwd: launch?.cwd ?? terminal.workingDirectory,
        ...(size.cols === undefined ? {} : { cols: size.cols }),
        ...(size.rows === undefined ? {} : { rows: size.rows }),
        ...(resolved ? { command: { file: resolved.file, args: resolved.args }, env: resolved.env } : {}),
      });
      const startedAt = new Date();
      this.#runtime.get(terminal.id)?.stopTelemetry?.();
      this.#runtime.set(terminal.id, {
        workspaceId: terminal.workspaceId,
        terminalId: created.id,
        state: "running",
        exitCode: null,
        startedAt,
        metrics: null,
        attention: null,
        activity: null,
        respond: null,
        stopTelemetry: null,
      });
      this.#byTerminal.set(created.id, terminal.id);
      this.#logger.info("Terminal agent started", {
        agentTerminalId: terminal.id,
        purpose: terminal.purpose,
        providerId: terminal.providerId,
      });
      const next: AgentTerminal = {
        ...terminal,
        terminalId: created.id,
        state: "running",
        exitCode: null,
        startedAt,
        metrics: null,
        attention: null,
        activity: null,
      };
      delete (next as { detail?: string }).detail;
      if (launch?.telemetry) {
        this.#follow(terminal.id, launch.telemetry);
      }
      if (this.#transient.has(terminal.id)) {
        this.#transient.set(terminal.id, next);
      }
      this.#publish(next);
      return next;
    } catch (error) {
      return this.#fail(terminal, error instanceof Error ? error.message : String(error));
    }
  }

  /**
   * Follows what the tool reports about this run. Updates are published at a
   * calm rate and only when something changed, so a chatty status line does
   * not flood the renderer.
   */
  #follow(id: string, telemetry: NonNullable<InteractiveLaunch["telemetry"]>): void {
    let lastSignature = "";
    let timer: ReturnType<typeof setTimeout> | null = null;
    let stopped = false;
    const flush = (): void => {
      timer = null;
      void this.#require(id)
        .then((terminal) => this.#publish(terminal))
        .catch(() => undefined);
    };
    const stopWatching = telemetry.watch((metrics) => {
      const runtime = this.#runtime.get(id);
      if (stopped || !runtime) {
        return;
      }
      const signature = JSON.stringify({ ...metrics, updatedAt: undefined });
      if (signature === lastSignature) {
        return;
      }
      lastSignature = signature;
      runtime.metrics = metrics;
      timer ??= setTimeout(flush, METRICS_THROTTLE_MS);
    });
    // A tool waiting on the person is news at once, not at the metrics' pace:
    // it is published as soon as it changes.
    let lastAttention: string | null = null;
    const stopAttention =
      telemetry.watchAttention?.((attention) => {
        const runtime = this.#runtime.get(id);
        if (stopped || !runtime || runtime.state !== "running") {
          return;
        }
        const signature = attention ? JSON.stringify(attention) : null;
        if (signature === lastAttention) {
          return;
        }
        lastAttention = signature;
        runtime.attention = attention;
        // Carries any metrics still waiting for their slot along with it.
        if (timer) {
          clearTimeout(timer);
        }
        flush();
      }) ?? null;
    // Working or idle changes what the island shows, so it is published at
    // once as well.
    let lastActivity: string | null = null;
    const stopActivity =
      telemetry.watchActivity?.((activity) => {
        const runtime = this.#runtime.get(id);
        if (stopped || !runtime || runtime.state !== "running") {
          return;
        }
        const signature = activity ? JSON.stringify(activity) : null;
        if (signature === lastActivity) {
          return;
        }
        lastActivity = signature;
        runtime.activity = activity;
        if (timer) {
          clearTimeout(timer);
        }
        flush();
      }) ?? null;
    const stop = (): void => {
      stopped = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      stopWatching();
      stopAttention?.();
      stopActivity?.();
    };
    const runtime = this.#runtime.get(id);
    if (runtime) {
      runtime.stopTelemetry = stop;
      runtime.respond = telemetry.respond ? telemetry.respond.bind(telemetry) : null;
    } else {
      stop();
    }
    this.#logger.debug("Following terminal telemetry", {
      agentTerminalId: id,
      source: telemetry.source,
    });
  }

  #fail(terminal: AgentTerminal, detail: string): AgentTerminal {
    this.#logger.warn("Terminal agent could not start", {
      agentTerminalId: terminal.id,
      providerId: terminal.providerId,
      error: detail,
    });
    this.#runtime.set(terminal.id, {
      workspaceId: terminal.workspaceId,
      terminalId: null,
      state: "failed",
      exitCode: null,
      detail,
      startedAt: null,
      metrics: null,
      attention: null,
      activity: null,
      respond: null,
      stopTelemetry: null,
    });
    const next: AgentTerminal = {
      ...terminal,
      terminalId: null,
      state: "failed",
      detail,
      metrics: null,
      attention: null,
      activity: null,
    };
    this.#publish(next);
    return next;
  }

  async #require(id: string): Promise<AgentTerminal> {
    const transient = this.#transient.get(id);
    if (transient) {
      return transient;
    }
    const [row] = await this.#db.select().from(agentTerminals).where(eq(agentTerminals.id, id)).limit(1);
    if (!row) {
      throw new Error(`Terminal agent "${id}" does not exist`);
    }
    return this.#compose(row);
  }

  #compose(row: AgentTerminalRow): AgentTerminal {
    const runtime = this.#runtime.get(row.id);
    const permission = permissionModeSchema.safeParse(row.permissionMode);
    return {
      id: row.id,
      workspaceId: row.workspaceId,
      purpose: row.purpose === "shell" ? "shell" : row.purpose === "login" ? "login" : "agent",
      providerId: row.providerId,
      label: row.label,
      modelId: row.modelId,
      reasoningEffort: row.reasoningEffort,
      permissionMode: permission.success ? permission.data : null,
      workingDirectory: row.workingDirectory,
      terminalId: runtime?.terminalId ?? null,
      state: runtime?.state ?? "stopped",
      exitCode: runtime?.exitCode ?? null,
      ...(runtime?.detail ? { detail: runtime.detail } : {}),
      startedAt: runtime?.startedAt ?? null,
      metrics: runtime?.metrics ?? null,
      // What the tool itself reported comes first; its screen fills in when
      // it reported nothing.
      attention: runtime?.attention ?? (runtime?.state === "running" ? runtime.screen?.attention : null) ?? null,
      activity: runtime?.activity ?? null,
      createdAt: row.createdAt,
    };
  }

  #publish(terminal: AgentTerminal): void {
    this.#events.publish({ type: "agentTerminal.changed", terminal });
  }
}
