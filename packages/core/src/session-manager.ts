import { and, asc, eq } from "drizzle-orm";
import type { Database } from "@ai-workbench/database";
import { chatMessages, sessions, type ChatMessageRow, type SessionRow } from "@ai-workbench/database";
import {
  normalizeError,
  type AIProviderAdapter,
  type ProviderSessionHandle,
} from "@ai-workbench/provider-base";
import type {
  ChatMessage,
  CreateSessionInput,
  Logger,
  MessageStatus,
  MessageUsage,
  NormalizedProviderError,
  Session,
  SessionStatus,
  ToolCallRecord,
  UpdateSessionInput,
} from "@ai-workbench/shared";
import type { EventBus } from "./event-bus.js";
import { createId } from "./ids.js";
import { resolveInsideRoot } from "./paths.js";
import type { ProviderManager } from "./provider-manager.js";
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
  readonly finished: Promise<void>;
  cancelled: boolean;
}

export interface SessionManagerOptions {
  readonly db: Database;
  readonly events: EventBus;
  readonly logger: Logger;
  readonly providers: ProviderManager;
  readonly workspaces: WorkspaceManager;
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
  readonly #runs = new Map<string, ActiveRun>();

  constructor(options: SessionManagerOptions) {
    this.#db = options.db;
    this.#events = options.events;
    this.#logger = options.logger.child("SESSION");
    this.#providers = options.providers;
    this.#workspaces = options.workspaces;
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
      enabledSkills: [],
      enabledPlugins: [],
      enabledMcpServers: [],
      settings: {},
      uiState: {},
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
   * Persists the user turn and starts the provider run. Returns as soon as the
   * assistant message exists; the answer itself arrives as domain events.
   */
  async sendMessage(sessionId: string, text: string): Promise<{ messageId: string }> {
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

    const userMessage = await this.#insertMessage({
      sessionId,
      role: "user",
      content: text,
      status: "complete",
      providerId: null,
      modelId: null,
    });
    this.#events.publish({ type: "message.created", message: userMessage });

    const resolved = await this.#ensureProviderSession(session, adapter);
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
      cancelled: false,
      finished: Promise.resolve(),
    };
    const finished = this.#stream(run, session.providerId, assistantMessage, text).finally(
      () => {
        this.#runs.delete(sessionId);
      },
    );
    this.#runs.set(sessionId, { ...run, finished });

    return { messageId: assistantMessage.id };
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
    await run.finished;
    return true;
  }

  /** Stops every active run; used on application shutdown (spec §132). */
  async shutdown(): Promise<void> {
    await Promise.all([...this.#runs.keys()].map((id) => this.cancel(id)));
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
    text: string,
  ): Promise<void> {
    const sessionId = message.sessionId;
    let content = "";
    let usage: MessageUsage | null = null;
    let error: NormalizedProviderError | null = null;
    let status: MessageStatus = "complete";
    const toolCalls: ToolCallRecord[] = [];

    this.#publishStatus(sessionId, "working");

    try {
      for await (const event of run.adapter.sendMessage(run.handle, { text })) {
        this.#events.publish({
          type: "provider.event",
          sessionId,
          providerId,
          event,
        });

        switch (event.type) {
          case "text_delta": {
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
            break;
          }
          case "usage": {
            usage = event.usage;
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
    const config = {
      sessionId: session.id,
      workingDirectory: session.workingDirectory,
      ...(session.modelId ? { modelId: session.modelId } : {}),
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
    usage: (row.usage ?? null) as MessageUsage | null,
    error: row.error,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
