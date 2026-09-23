import { and, asc, eq } from "drizzle-orm";
import type { Database } from "@ai-workbench/database";
import { chatMessages, sessions, type ChatMessageRow, type SessionRow } from "@ai-workbench/database";
import {
  normalizeError,
  type AgentMessage,
  type AIProviderAdapter,
  type ProviderSessionHandle,
  type ProviderToolAccess,
} from "@ai-workbench/provider-base";
import { readSessionRuntimeSettings } from "@ai-workbench/shared";
import type {
  ChatMessage,
  CreateSessionInput,
  MessageAttachment,
  Logger,
  ProviderCapabilities,
  MessageStatus,
  MessageUsage,
  NormalizedProviderError,
  Session,
  SessionStatus,
  ToolCallRecord,
  UpdateSessionInput,
} from "@ai-workbench/shared";
import { join } from "node:path";
import { AttachmentError, forgetAttachments, inspectAttachments, keepAttachments } from "./attachments.js";
import type { EventBus } from "./event-bus.js";
import { resolveInsideRoot } from "@ai-workbench/workspace-fs";
import { createId } from "./ids.js";
import type { ProviderManager } from "./provider-manager.js";
import type { McpService } from "./mcp-service.js";
import type { SkillService } from "./skill-service.js";
import { ToolBridge } from "./tool-bridge.js";
import type { WorkspaceManager } from "./workspace-manager.js";

export class SessionNotFoundError extends Error {
  constructor(id: string) {
    super(`Session "${id}" does not exist`);
    this.name = "SessionNotFoundError";
  }
}

export class SessionBusyError extends Error {
  constructor(id: string) {
    super(`Session "${id}" is still responding`);
    this.name = "SessionBusyError";
  }
}

export class NoProviderSelectedError extends Error {
  constructor(id: string) {
    super(`Session "${id}" has no usable provider selected`);
    this.name = "NoProviderSelectedError";
  }
}

interface ActiveRun {
  readonly handle: ProviderSessionHandle;
  readonly adapter: AIProviderAdapter;
  finished: Promise<void>;
  cancelled: boolean;
  /** What the turn is doing, from the tool's own events; see `activity`. */
  activity?: string;
}

export interface SessionManagerOptions {
  readonly db: Database;
  readonly events: EventBus;
  readonly logger: Logger;
  readonly providers: ProviderManager;
  readonly workspaces: WorkspaceManager;
  /** Optional: without them a session simply gets no skills and no tools. */
  readonly skills?: SkillService;
  readonly mcp?: McpService;
  /**
   * Where each session keeps copies of the files sent in it. Without one,
   * files go to the tool from where the person picked them.
   */
  readonly attachmentsDirectory?: string;
}

/**
 * Owns session persistence and the request/response lifecycle. A run lives here
 * and not in the UI, so a session keeps streaming while its tab is hidden or the
 * main window is closed (spec §91, §104).
 */
export class SessionManager {
  readonly #db: Database;
  readonly #events: EventBus;
  readonly #logger: Logger;
  readonly #providers: ProviderManager;
  readonly #workspaces: WorkspaceManager;
  readonly #skills: SkillService | undefined;
  readonly #mcp: McpService | undefined;
  readonly #attachmentsDirectory: string | undefined;
  readonly #toolBridge = new ToolBridge();
  readonly #runs = new Map<string, ActiveRun>();

  constructor(options: SessionManagerOptions) {
    this.#db = options.db;
    this.#events = options.events;
    this.#logger = options.logger.child("SESSION");
    this.#providers = options.providers;
    this.#workspaces = options.workspaces;
    this.#skills = options.skills;
    this.#mcp = options.mcp;
    this.#attachmentsDirectory = options.attachmentsDirectory;
  }

  async list(workspaceId?: string): Promise<Session[]> {
    const rows = workspaceId
      ? await this.#db.select().from(sessions).where(eq(sessions.workspaceId, workspaceId))
      : await this.#db.select().from(sessions);
    return rows
      .map(toSession)
      .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
  }

  async get(id: string): Promise<Session | null> {
    const [row] = await this.#db.select().from(sessions).where(eq(sessions.id, id)).limit(1);
    return row ? toSession(row) : null;
  }

  async require(id: string): Promise<Session> {
    const session = await this.get(id);
    if (!session) {
      throw new SessionNotFoundError(id);
    }
    return session;
  }

  async create(input: CreateSessionInput): Promise<Session> {
    const workspace = await this.#workspaces.require(input.workspaceId);
    const workingDirectory = input.workingDirectory
      ? resolveInsideRoot(workspace.path, input.workingDirectory)
      : workspace.path;

    const providerId = input.providerId ?? this.#providers.defaultProviderId();
    const now = new Date();
    const row: SessionRow = {
      id: createId("ses"),
      workspaceId: workspace.id,
      name: input.name.trim(),
      type: input.type,
      providerId: providerId ?? null,
      modelId: input.modelId ?? null,
      workingDirectory,
      providerSessionId: null,
      enabledSkills: input.enabledSkills ?? [],
      enabledPlugins: input.enabledPlugins ?? [],
      enabledMcpServers: input.enabledMcpServers ?? [],
      settings: input.settings ?? {},
      uiState: input.uiState ?? {},
      createdAt: now,
      updatedAt: now,
    };

    await this.#db.insert(sessions).values(row);
    const session = toSession(row);
    this.#logger.info("Session created", {
      sessionId: session.id,
      workspaceId: workspace.id,
      providerId: session.providerId,
    });
    this.#events.publish({ type: "session.created", session });
    return session;
  }

  async update(input: UpdateSessionInput): Promise<Session> {
    const existing = await this.require(input.id);
    const workspace = await this.#workspaces.require(existing.workspaceId);

    const workingDirectory =
      input.workingDirectory === undefined
        ? existing.workingDirectory
        : resolveInsideRoot(workspace.path, input.workingDirectory);

    // Changing provider invalidates the provider-native session id.
    const providerChanged =
      input.providerId !== undefined && input.providerId !== existing.providerId;

    const updated: Session = {
      ...existing,
      ...(input.name === undefined ? {} : { name: input.name.trim() }),
      ...(input.providerId === undefined ? {} : { providerId: input.providerId }),
      ...(input.modelId === undefined ? {} : { modelId: input.modelId }),
      ...(input.enabledSkills === undefined ? {} : { enabledSkills: input.enabledSkills }),
      ...(input.enabledPlugins === undefined ? {} : { enabledPlugins: input.enabledPlugins }),
      ...(input.enabledMcpServers === undefined
        ? {}
        : { enabledMcpServers: input.enabledMcpServers }),
      ...(input.settings === undefined ? {} : { settings: input.settings }),
      ...(input.uiState === undefined ? {} : { uiState: input.uiState }),
      workingDirectory,
      providerSessionId: providerChanged ? null : existing.providerSessionId,
      updatedAt: new Date(),
    };

    await this.#db
      .update(sessions)
      .set({
        name: updated.name,
        providerId: updated.providerId,
        modelId: updated.modelId,
        workingDirectory: updated.workingDirectory,
        providerSessionId: updated.providerSessionId,
        enabledSkills: updated.enabledSkills,
        enabledPlugins: updated.enabledPlugins,
        enabledMcpServers: updated.enabledMcpServers,
        settings: updated.settings,
        uiState: updated.uiState,
        updatedAt: updated.updatedAt,
      })
      .where(eq(sessions.id, updated.id));

    this.#events.publish({ type: "session.updated", session: updated });
    return updated;
  }

  async delete(id: string): Promise<boolean> {
    const existing = await this.get(id);
    if (!existing) {
      return false;
    }
    await this.cancel(id);
    await this.#destroyProviderSession(existing);
    await this.#db.delete(sessions).where(eq(sessions.id, id));
    if (this.#attachmentsDirectory) {
      await forgetAttachments(join(this.#attachmentsDirectory, id)).catch((error: unknown) => {
        this.#logger.warn("Could not remove a session's attached files", {
          sessionId: id,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }
    this.#events.publish({ type: "session.deleted", sessionId: id });
    return true;
  }

  async listMessages(sessionId: string, limit = 500): Promise<ChatMessage[]> {
    const rows = await this.#db
      .select()
      .from(chatMessages)
      .where(eq(chatMessages.sessionId, sessionId))
      .orderBy(asc(chatMessages.createdAt))
      .limit(limit);
    return rows.map(toChatMessage);
  }

  isBusy(sessionId: string): boolean {
    return this.#runs.has(sessionId);
  }

  /**
   * What a busy session's turn is doing right now, in the tool's own words:
   * the command or file of the tool call in flight, or "writing" while text
   * arrives. Null when idle or before the tool said anything.
   */
  activity(sessionId: string): string | null {
    return this.#runs.get(sessionId)?.activity ?? null;
  }

  /**
   * Persists the user turn and starts the provider run. Returns as soon as the
   * assistant message exists; the answer itself arrives as domain events.
   */
  async sendMessage(
    sessionId: string,
    text: string,
    attachments: readonly Pick<MessageAttachment, "path">[] = [],
  ): Promise<{ messageId: string }> {
    const session = await this.require(sessionId);
    if (this.#runs.has(sessionId)) {
      throw new SessionBusyError(sessionId);
    }
    if (!session.providerId) {
      throw new NoProviderSelectedError(sessionId);
    }
    const adapter = this.#providers.get(session.providerId);
    if (!adapter) {
      throw new NoProviderSelectedError(sessionId);
    }

    // Claim the session synchronously, before any await, so a second call
    // cannot slip through while the first is still inserting messages.
    const placeholder: ActiveRun = {
      handle: { sessionId, providerSessionId: session.providerSessionId ?? sessionId },
      adapter,
      cancelled: false,
      finished: Promise.resolve(),
    };
    this.#runs.set(sessionId, placeholder);

    let sent: MessageAttachment[];
    try {
      sent = await this.#prepareAttachments(sessionId, adapter, attachments);
    } catch (error) {
      this.#runs.delete(sessionId);
      throw error;
    }

    const userMessage = await this.#insertMessage({
      sessionId,
      role: "user",
      content: text,
      status: "complete",
      providerId: null,
      modelId: null,
      attachments: sent,
    });
    this.#events.publish({ type: "message.created", message: userMessage });

    let resolved: { handle: ProviderSessionHandle };
    try {
      resolved = await this.#ensureProviderSession(session, adapter);
    } catch (error) {
      // No assistant row exists yet, so nothing is stuck streaming — but the
      // failure must be visible as an answer, not just a throw.
      const message = error instanceof Error ? error.message : String(error);
      const failed = await this.#insertMessage({
        sessionId,
        role: "assistant",
        content: message,
        status: "failed",
        providerId: session.providerId,
        modelId: session.modelId,
      });
      this.#events.publish({ type: "message.created", message: failed });
      this.#runs.delete(sessionId);
      throw error;
    }
    // A cancel that landed while the provider session was starting must win:
    // do not start streaming a run the user already stopped.
    if (placeholder.cancelled) {
      const cancelled = await this.#insertMessage({
        sessionId,
        role: "assistant",
        content: "cancelled",
        status: "failed",
        providerId: session.providerId,
        modelId: session.modelId,
      });
      this.#events.publish({ type: "message.created", message: cancelled });
      this.#runs.delete(sessionId);
      throw new Error("cancelled");
    }
    const assistantMessage = await this.#insertMessage({
      sessionId,
      role: "assistant",
      content: "",
      status: "streaming",
      providerId: session.providerId,
      modelId: resolved.handle.modelId ?? session.modelId,
    });
    this.#events.publish({ type: "message.created", message: assistantMessage });

    const run: ActiveRun = {
      handle: resolved.handle,
      adapter,
      cancelled: placeholder.cancelled,
      finished: Promise.resolve(),
    };
    // The object the stream reads is the one registered: a cancel marks it,
    // and the stream must see that mark (it used to land on a copy, so a turn
    // stopped by the person was saved as complete when the tool finished).
    const message = {
      text,
      ...(sent.length > 0
        ? { attachments: sent.map(({ kind, path }) => ({ kind, path })) }
        : {}),
    };
    run.finished = this.#stream(run, session.providerId, assistantMessage, message).finally(
      () => {
        this.#runs.delete(sessionId);
      },
    );
    this.#runs.set(sessionId, run);

    return { messageId: assistantMessage.id };
  }

  /**
   * The files going with a message, checked on disk and, when the session has
   * a folder for them, copied there. A provider that cannot take files is
   * never handed any.
   */
  async #prepareAttachments(
    sessionId: string,
    adapter: AIProviderAdapter,
    attachments: readonly Pick<MessageAttachment, "path">[],
  ): Promise<MessageAttachment[]> {
    if (attachments.length === 0) {
      return [];
    }
    const capabilities = await this.#safeCapabilities(adapter);
    if (!capabilities?.supported.includes("attachments")) {
      throw new AttachmentError(`${adapter.metadata.displayName} does not take files with a message.`);
    }
    const inspected = await inspectAttachments(attachments);
    if (!this.#attachmentsDirectory) {
      return inspected;
    }
    return keepAttachments(inspected, join(this.#attachmentsDirectory, sessionId, createId("files")));
  }

  async cancel(sessionId: string): Promise<boolean> {
    const run = this.#runs.get(sessionId);
    if (!run) {
      return false;
    }
    run.cancelled = true;
    try {
      await run.adapter.cancel(run.handle);
    } catch (error) {
      this.#logger.warn("Provider cancellation failed", {
        sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    // An adapter that ignores cancellation must not hang shutdown: after a
    // grace period the run is retired regardless and the stream is released.
    await Promise.race([
      run.finished.catch(() => undefined),
      new Promise((resolve) => setTimeout(resolve, 5_000)),
    ]);
    return true;
  }

  /** Stops every active run; used on application shutdown (spec §132). */
  async shutdown(): Promise<void> {
    await Promise.all([...this.#runs.keys()].map((id) => this.cancel(id)));
  }

  /**
   * Turns interrupted by a crash or a kill never finish on their own: on
   * startup every message still marked streaming becomes a visible failure
   * instead of a permanently animated row (spec §53, sessions side).
   */
  async recoverInterrupted(): Promise<number> {
    const stale = await this.#db
      .select({ id: chatMessages.id })
      .from(chatMessages)
      .where(eq(chatMessages.status, "streaming"));
    for (const row of stale) {
      await this.#db
        .update(chatMessages)
        .set({
          status: "failed",
          error: "Interrupted by restart",
          updatedAt: new Date(),
        })
        .where(eq(chatMessages.id, row.id));
    }
    if (stale.length > 0) {
      this.#logger.info("Recovered interrupted turns", { count: stale.length });
    }
    return stale.length;
  }

  /**
   * Releases the provider-side session. A provider that cannot do it, or is no
   * longer registered, must not block deleting the local session.
   */
  async #destroyProviderSession(session: Session): Promise<void> {
    if (!session.providerId || !session.providerSessionId) {
      return;
    }
    const adapter = this.#providers.get(session.providerId);
    if (!adapter) {
      return;
    }
    try {
      await adapter.destroySession({
        sessionId: session.id,
        providerSessionId: session.providerSessionId,
        ...(session.modelId ? { modelId: session.modelId } : {}),
      });
    } catch (error) {
      this.#logger.warn("Provider session cleanup failed", {
        sessionId: session.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async #stream(
    run: ActiveRun,
    providerId: string,
    message: ChatMessage,
    request: AgentMessage,
  ): Promise<void> {
    const sessionId = message.sessionId;
    let content = "";
    let usage: MessageUsage | null = null;
    let error: NormalizedProviderError | null = null;
    let status: MessageStatus = "complete";
    const toolCalls: ToolCallRecord[] = [];

    this.#publishStatus(sessionId, "working");

    try {
      for await (const event of run.adapter.sendMessage(run.handle, request)) {
        this.#events.publish({
          type: "provider.event",
          sessionId,
          providerId,
          event,
        });

        switch (event.type) {
          case "text_delta": {
            run.activity = "writing";
            content += event.text;
            this.#events.publish({
              type: "message.delta",
              sessionId,
              messageId: message.id,
              text: event.text,
            });
            break;
          }
          case "message": {
            content = event.text;
            break;
          }
          case "status": {
            this.#publishStatus(sessionId, mapStatus(event.status));
            break;
          }
          case "tool_call":
          case "tool_result": {
            upsertToolCall(toolCalls, event.toolCall);
            const call = event.toolCall;
            const what = (call.summary ?? call.name).slice(0, 140);
            run.activity =
              event.type === "tool_call" || call.state === "running" ? `${call.name}: ${what}` : "thinking";
            break;
          }
          case "usage": {
            // A turn may report limits and token counts in separate events;
            // each adds what it knows instead of erasing the other.
            usage = mergeUsage(usage, event.usage);
            break;
          }
          case "warning": {
            this.#logger.warn("Provider warning", { sessionId, message: event.message });
            break;
          }
          case "error": {
            error = event.error;
            status = "failed";
            break;
          }
          case "session": {
            // A CLI provider assigns its session id during the first turn, so
            // the placeholder stored at session creation is replaced here —
            // otherwise the next turn could not resume the conversation.
            await this.#persistProviderSessionId(sessionId, event.providerSessionId);
            break;
          }
          case "completed": {
            if (event.reason === "cancelled") {
              status = "cancelled";
            } else if (event.reason === "failed" && status !== "failed") {
              status = "failed";
            }
            break;
          }
        }
      }
    } catch (caught) {
      error = normalizeError(caught);
      status = error.kind === "cancelled" ? "cancelled" : "failed";
      this.#logger.error("Provider run failed", {
        sessionId,
        providerId,
        error: error.message,
      });
    }

    if (run.cancelled && status === "complete") {
      status = "cancelled";
    }

    const finalMessage: ChatMessage = {
      ...message,
      content,
      status,
      toolCalls,
      usage,
      error: error?.message ?? null,
      updatedAt: new Date(),
    };

    await this.#db
      .update(chatMessages)
      .set({
        content: finalMessage.content,
        status: finalMessage.status,
        toolCalls: finalMessage.toolCalls,
        usage: finalMessage.usage,
        error: finalMessage.error,
        updatedAt: finalMessage.updatedAt,
      })
      .where(eq(chatMessages.id, message.id));

    await this.#touchSession(sessionId);

    // A session that still has its generated name takes the topic of its
    // first exchange, so past conversations stay findable. Renamed sessions
    // are never touched.
    if (status === "complete") {
      await this.#nameFromFirstExchange(sessionId, request.text).catch((error: unknown) => {
        this.#logger.debug("Session could not be named from its first turn", {
          sessionId,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }

    // The run is retired before the terminal events are published, so anything
    // reacting to the finished answer already sees an idle session and may send
    // the next message immediately.
    this.#runs.delete(sessionId);

    this.#events.publish({ type: "message.updated", message: finalMessage });
    if (error) {
      this.#events.publish({
        type: "message.failed",
        sessionId,
        messageId: message.id,
        error,
      });
    }
    this.#publishStatus(sessionId, status === "failed" ? "error" : "idle");
  }

  /** Skills that apply to this session, as provider system instructions. */
  async #nameFromFirstExchange(sessionId: string, text: string): Promise<void> {
    const session = await this.get(sessionId);
    if (!session || !/^Session \d+$/.test(session.name)) {
      return;
    }
    const messages = await this.listMessages(sessionId, 10);
    // Only the very first exchange names the session: one user turn and the
    // answer that just completed.
    if (messages.length !== 2 || messages[0]?.role !== "user") {
      return;
    }
    const topic = text.split("\n")[0]?.replace(/\s+/g, " ").trim() ?? "";
    if (topic.length === 0) {
      return;
    }
    await this.update({ id: sessionId, name: topic.slice(0, 48) });
  }

  async #buildSystemInstructions(
    session: Session,
    capabilities: ProviderCapabilities | null,
  ): Promise<string> {
    if (!this.#skills) {
      return "";
    }
    try {
      const effective = await this.#skills.resolveForSession({
        sessionId: session.id,
        workspaceId: session.workspaceId,
        ...(capabilities ? { capabilities } : {}),
      });
      return this.#skills.buildInstructions(effective);
    } catch (error) {
      // A skill problem must not stop the conversation.
      this.#logger.warn("Skills could not be resolved", {
        sessionId: session.id,
        error: error instanceof Error ? error.message : String(error),
      });
      return "";
    }
  }

  /** Tool access for this session, decided by capability rather than brand. */
  async #buildToolAccess(
    session: Session,
    capabilities: ProviderCapabilities | null,
  ): Promise<ProviderToolAccess | null> {
    if (!this.#mcp || !capabilities) {
      return null;
    }
    try {
      const enabledServerIds = await this.#mcp.enabledForSession(session.id);
      if (enabledServerIds.length === 0) {
        return null;
      }

      const plan = this.#toolBridge.plan({
        capabilities,
        enabledServerIds,
        configs: await this.#mcp.list(),
        statuses: this.#mcp.statuses(),
        toolsFor: (ids) => this.#mcp!.manager.toolsForSession(ids),
      });

      for (const entry of plan.unavailable) {
        this.#logger.warn("MCP server is enabled but unusable", {
          sessionId: session.id,
          serverId: entry.id,
          reason: entry.reason,
        });
      }

      return {
        kind: plan.kind,
        mcpServers: plan.mcpServers,
        hostTools: plan.hostTools,
      };
    } catch (error) {
      this.#logger.warn("Tool access could not be resolved", {
        sessionId: session.id,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  async #safeCapabilities(
    adapter: AIProviderAdapter,
  ): Promise<ProviderCapabilities | null> {
    try {
      return await adapter.getCapabilities();
    } catch {
      return null;
    }
  }

  /** Stores a provider-assigned session id and tells the UI about it. */
  async #persistProviderSessionId(
    sessionId: string,
    providerSessionId: string,
  ): Promise<void> {
    const current = await this.get(sessionId);
    if (!current || current.providerSessionId === providerSessionId) {
      return;
    }

    const updatedAt = new Date();
    await this.#db
      .update(sessions)
      .set({ providerSessionId, updatedAt })
      .where(eq(sessions.id, sessionId));

    this.#events.publish({
      type: "session.updated",
      session: { ...current, providerSessionId, updatedAt },
    });
  }

  /**
   * Reuses the provider-native session when the adapter can resume it, so a
   * restarted app continues the same conversation (spec §23).
   */
  async #ensureProviderSession(
    session: Session,
    adapter: AIProviderAdapter,
  ): Promise<{ handle: ProviderSessionHandle }> {
    const capabilities = await this.#safeCapabilities(adapter);
    const systemInstructions = await this.#buildSystemInstructions(session, capabilities);
    const toolAccess = await this.#buildToolAccess(session, capabilities);
    // Effort and permission are chosen per session and apply from the next
    // turn on, without starting a new provider conversation.
    const runtime = readSessionRuntimeSettings(session.settings);

    const config = {
      sessionId: session.id,
      workingDirectory: session.workingDirectory,
      ...(session.modelId ? { modelId: session.modelId } : {}),
      ...(systemInstructions ? { systemInstructions } : {}),
      ...(toolAccess ? { toolAccess } : {}),
      ...(runtime.reasoningEffort ? { reasoningEffort: runtime.reasoningEffort } : {}),
      ...(runtime.permissionMode ? { permissionMode: runtime.permissionMode } : {}),
    };

    let info = null;
    if (session.providerSessionId && adapter.resumeSession) {
      try {
        info = await adapter.resumeSession(session.providerSessionId, config);
      } catch (error) {
        this.#logger.warn("Session resume failed, starting a new provider session", {
          sessionId: session.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    info ??= await adapter.createSession(config);

    if (
      info.providerSessionId !== session.providerSessionId ||
      (info.modelId && info.modelId !== session.modelId)
    ) {
      const updatedAt = new Date();
      await this.#db
        .update(sessions)
        .set({
          providerSessionId: info.providerSessionId,
          modelId: info.modelId ?? session.modelId,
          updatedAt,
        })
        .where(eq(sessions.id, session.id));

      this.#events.publish({
        type: "session.updated",
        session: {
          ...session,
          providerSessionId: info.providerSessionId,
          modelId: info.modelId ?? session.modelId,
          updatedAt,
        },
      });
    }

    return {
      handle: {
        sessionId: session.id,
        providerSessionId: info.providerSessionId,
        ...(info.modelId ? { modelId: info.modelId } : {}),
        ...(runtime.reasoningEffort ? { reasoningEffort: runtime.reasoningEffort } : {}),
        ...(runtime.permissionMode ? { permissionMode: runtime.permissionMode } : {}),
      },
    };
  }

  async #insertMessage(input: {
    sessionId: string;
    role: ChatMessage["role"];
    content: string;
    status: MessageStatus;
    providerId: string | null;
    modelId: string | null;
    attachments?: MessageAttachment[];
  }): Promise<ChatMessage> {
    const now = new Date();
    const row: ChatMessageRow = {
      id: createId("msg"),
      sessionId: input.sessionId,
      role: input.role,
      content: input.content,
      status: input.status,
      providerId: input.providerId,
      modelId: input.modelId,
      toolCalls: [],
      attachments: input.attachments ?? [],
      usage: null,
      error: null,
      createdAt: now,
      updatedAt: now,
    };
    await this.#db.insert(chatMessages).values(row);
    return toChatMessage(row);
  }

  async #touchSession(sessionId: string): Promise<void> {
    await this.#db
      .update(sessions)
      .set({ updatedAt: new Date() })
      .where(and(eq(sessions.id, sessionId)));
  }

  #publishStatus(sessionId: string, status: SessionStatus): void {
    this.#events.publish({ type: "session.status.changed", sessionId, status });
  }
}

/** Maps a free-form adapter status string onto the semantic session status. */
function mapStatus(status: string): SessionStatus {
  switch (status) {
    case "planning":
      return "planning";
    case "streaming":
      return "streaming";
    case "waiting":
      return "waiting";
    case "error":
      return "error";
    default:
      return "working";
  }
}

function upsertToolCall(list: ToolCallRecord[], toolCall: ToolCallRecord): void {
  const index = list.findIndex((entry) => entry.id === toolCall.id);
  if (index === -1) {
    list.push(toolCall);
  } else {
    list[index] = toolCall;
  }
}

function toSession(row: SessionRow): Session {
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    workspaceId: row.workspaceId,
    providerId: row.providerId,
    modelId: row.modelId,
    workingDirectory: row.workingDirectory,
    providerSessionId: row.providerSessionId,
    enabledSkills: row.enabledSkills,
    enabledPlugins: row.enabledPlugins,
    enabledMcpServers: row.enabledMcpServers,
    settings: row.settings,
    uiState: row.uiState,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toChatMessage(row: ChatMessageRow): ChatMessage {
  return {
    id: row.id,
    sessionId: row.sessionId,
    role: row.role,
    content: row.content,
    status: row.status,
    providerId: row.providerId,
    modelId: row.modelId,
    // Written by this module through typed inserts.
    toolCalls: row.toolCalls as ToolCallRecord[],
    attachments: row.attachments as MessageAttachment[],
    usage: (row.usage ?? null) as MessageUsage | null,
    error: row.error,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** Combines what several usage events of one turn reported. */
function mergeUsage(previous: MessageUsage | null, next: MessageUsage): MessageUsage {
  if (!previous) {
    return next;
  }
  return {
    ...previous,
    ...next,
    limits: next.limits.length > 0 ? next.limits : previous.limits,
  };
}
