import { and, asc, desc, eq } from "drizzle-orm";
import type { Database } from "@ai-workbench/database";
import { chatMessages, sessions, type ChatMessageRow, type SessionRow } from "@ai-workbench/database";
import {
  normalizeError,
  type AgentMessage,
  type AIProviderAdapter,
  type ProviderSessionHandle,
  type ProviderToolAccess,
} from "@ai-workbench/provider-base";
import { accountNoticeSchema, readSessionRuntimeSettings, turnDiffSchema } from "@ai-workbench/shared";
import type {
  AccountNotice,
  AppSettings,
  ChatMessage,
  CreateSessionInput,
  MessageAttachment,
  Logger,
  ProviderCapabilities,
  MessageStatus,
  MessageUsage,
  NormalizedProviderError,
  ProviderUsageSnapshot,
  Session,
  SessionStatus,
  ToolCallRecord,
  TurnDiff,
  UpdateSessionInput,
} from "@ai-workbench/shared";
import { join } from "node:path";
import { buildHandover, exhaustedUntil, pickNextAccount, type AccountStanding } from "./account-switch.js";
import { AttachmentError, forgetAttachments, inspectAttachments, keepAttachments } from "./attachments.js";
import type { EventBus } from "./event-bus.js";
import { resolveInsideRoot } from "@ai-workbench/workspace-fs";
import { createId } from "./ids.js";
import { withServerGuidance } from "./server-guidance.js";
import type { ProviderManager } from "./provider-manager.js";
import type { McpService } from "./mcp-service.js";
import type { SkillService } from "./skill-service.js";
import type { UsageService } from "./usage-service.js";
import type { WorkspaceManager } from "./workspace-manager.js";
import type { FolderHistory } from "./team-manager.js";

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
  readonly folderHistory?: FolderHistory;
  readonly db: Database;
  readonly events: EventBus;
  readonly logger: Logger;
  readonly providers: ProviderManager;
  readonly workspaces: WorkspaceManager;
  /** Optional: without them a session simply gets no skills and no tools. */
  readonly skills?: SkillService;
  /**
   * The MCP server that serves skills on demand. A session that has it gets
   * its skills as a short list and loads one when a task needs it, instead
   * of carrying every skill's full text on every turn.
   */
  readonly skillsServerId?: string;
  readonly mcp?: McpService;
  /**
   * Where each session keeps copies of the files sent in it. Without one,
   * files go to the tool from where the person picked them.
   */
  readonly attachmentsDirectory?: string;
  /** What tools last reported, to tell an account at its limit from a free one. */
  readonly usage?: UsageService;
  /** Where the person chose what happens at a limit; without it a chat stops. */
  readonly settings?: { get(): Promise<Pick<AppSettings, "limitAction">> };
}

/**
 * Owns session persistence and the request/response lifecycle. A run lives here
 * and not in the UI, so a session keeps streaming while its tab is hidden or the
 * main window is closed (spec §91, §104).
 */
export class SessionManager {
  readonly #folderHistory: FolderHistory | undefined;
  readonly #undoing = new Set<string>();
  readonly #watchedFolders = new Map<string, Set<{ concurrent: boolean }>>();
  readonly #db: Database;
  readonly #events: EventBus;
  readonly #logger: Logger;
  readonly #providers: ProviderManager;
  readonly #workspaces: WorkspaceManager;
  readonly #skills: SkillService | undefined;
  readonly #skillsServerId: string | undefined;
  readonly #mcp: McpService | undefined;
  readonly #attachmentsDirectory: string | undefined;
  readonly #usage: UsageService | undefined;
  readonly #settings: SessionManagerOptions["settings"];
  readonly #runs = new Map<string, ActiveRun>();
  /**
   * Accounts that reported a limit, and until when if they said. One whose
   * end is unknown stays limited until a turn on it succeeds again.
   */
  readonly #limited = new Map<string, { readonly until: Date | null }>();

  constructor(options: SessionManagerOptions) {
    this.#folderHistory = options.folderHistory;
    this.#db = options.db;
    this.#events = options.events;
    this.#logger = options.logger.child("SESSION");
    this.#providers = options.providers;
    this.#workspaces = options.workspaces;
    this.#skills = options.skills;
    this.#skillsServerId = options.skillsServerId;
    this.#mcp = options.mcp;
    this.#attachmentsDirectory = options.attachmentsDirectory;
    this.#usage = options.usage;
    this.#settings = options.settings;
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

  /** Copies the recorded conversation; the first new turn uses the normal handover path. */
  async fork(input: { sessionId: string; providerId: string; modelId?: string; reasoningEffort?: string }): Promise<Session> {
    const source = await this.require(input.sessionId);
    if (source.type !== "solo") throw new Error("Only solo conversations can be continued in another tool.");
    if (this.isBusy(source.id)) throw new SessionBusyError(source.id);
    const provider = await this.#providers.describe(input.providerId);
    if (!provider.enabled || !provider.capabilities.supported.includes("chat") || provider.installation.state !== "installed") {
      throw new Error("The selected tool is not ready to chat.");
    }
    if (input.modelId && !provider.models.some((model) => model.id === input.modelId)) throw new Error("The selected model is no longer available.");
    const rows = await this.#db.select().from(chatMessages).where(eq(chatMessages.sessionId, source.id)).orderBy(asc(chatMessages.createdAt));
    const target = await this.create({
      workspaceId: source.workspaceId,
      name: `${source.name} · ${provider.metadata.displayName}`.slice(0, 200),
      type: "solo", providerId: input.providerId,
      ...(input.modelId ? { modelId: input.modelId } : {}),
      workingDirectory: source.workingDirectory,
      enabledSkills: source.enabledSkills, enabledPlugins: source.enabledPlugins, enabledMcpServers: source.enabledMcpServers,
      settings: { forkedFrom: source.id, ...(input.reasoningEffort ? { reasoningEffort: input.reasoningEffort } : {}) },
    });
    try {
      for (const row of rows) {
        const messageId = createId("msg");
        const attachments = toChatMessage(row).attachments;
        const copied = attachments.length && this.#attachmentsDirectory
          ? await keepAttachments(attachments, join(this.#attachmentsDirectory, target.id, messageId))
          : attachments;
        // Old turn undo operations and actionable account notices belong only to the source.
        await this.#db.insert(chatMessages).values({ ...row, id: messageId, sessionId: target.id, attachments: copied, notice: null, turnDiff: null });
      }
      return target;
    } catch (error) {
      await this.delete(target.id);
      throw error;
    }
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
    const modelChanged = input.modelId !== undefined && input.modelId !== existing.modelId;
    // Effort belongs to a model. Carrying it to another one can silently
    // request an unsupported or more costly mode, including over direct IPC.
    const settings = input.settings ?? (providerChanged || modelChanged
      ? Object.fromEntries(Object.entries(existing.settings).filter(([key]) => key !== "reasoningEffort"))
      : existing.settings);

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
      settings,
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
    return this.#runs.has(sessionId) || this.#undoing.has(sessionId);
  }

  /** Undo is an explicit action on a recorded answer, never caller-supplied paths. */
  async undoTurn(sessionId: string, messageId: string): Promise<ChatMessage> {
    if (this.isBusy(sessionId)) throw new SessionBusyError(sessionId);
    const session = await this.require(sessionId);
    if ((await this.list()).some((other) => other.workingDirectory === session.workingDirectory && this.isBusy(other.id))) {
      throw new Error("Stop other sessions working in this folder before undoing a turn.");
    }
    this.#undoing.add(sessionId);
    try {
      const [row] = await this.#db.select().from(chatMessages).where(and(eq(chatMessages.id, messageId), eq(chatMessages.sessionId, sessionId)));
      const diff = row?.turnDiff ? turnDiffSchema.parse(row.turnDiff) : null;
      if (!row || !diff || !this.#folderHistory?.undo) throw new Error("This turn has no restorable snapshot.");
      if (diff.undoneAt) throw new Error("This turn was already undone.");
      if (diff.concurrent) throw new Error("Other sessions worked in this folder during this turn; attribution is uncertain.");
      if (diff.folder !== session.workingDirectory) throw new Error("The session folder changed; the original snapshot cannot be restored here.");
      await this.#folderHistory.undo(diff.folder, diff.before, diff.after);
      const updatedAt = new Date();
      const updated = { ...diff, undoneAt: updatedAt };
      await this.#db.update(chatMessages).set({ turnDiff: updated, updatedAt }).where(eq(chatMessages.id, messageId));
      const message = toChatMessage({ ...row, turnDiff: updated, updatedAt });
      this.#events.publish({ type: "message.updated", message });
      return message;
    } finally {
      this.#undoing.delete(sessionId);
    }
  }

  async #watchFolder(folder: string, messageId: string): Promise<() => Promise<TurnDiff | undefined>> {
    const history = this.#folderHistory;
    if (!history) return async () => undefined;
    const before = await history.snapshot(folder).catch(() => null);
    if (!before) return async () => undefined;
    const watchers = this.#watchedFolders.get(folder) ?? new Set<{ concurrent: boolean }>();
    const watcher = { concurrent: watchers.size > 0 };
    for (const existing of watchers) existing.concurrent = true;
    watchers.add(watcher);
    this.#watchedFolders.set(folder, watchers);
    return async () => {
      try {
        const after = await history.snapshot(folder);
        if (!after) return undefined;
        const change = await history.compare(folder, before, after);
        if (change.files.length === 0) return undefined;
        await history.retainSnapshot?.(folder, `${messageId}/before`, before);
        await history.retainSnapshot?.(folder, `${messageId}/after`, after);
        return { before, after, folder, files: [...change.files], diff: change.diff, truncated: change.truncated, concurrent: watcher.concurrent, undoneAt: null };
      } catch (error) {
        this.#logger.warn("Turn diff could not be recorded", { error: error instanceof Error ? error.message : String(error) });
        return undefined;
      } finally {
        watchers.delete(watcher);
        if (watchers.size === 0) this.#watchedFolders.delete(folder);
      }
    };
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

    return this.#startTurn(session, adapter, session.providerId, placeholder, userMessage);
  }

  /**
   * Goes on after an account reached its limit and the person chose to
   * continue on the account the chat offered: the same message is answered
   * there, with the conversation carried along.
   */
  async continueOnAccount(sessionId: string): Promise<{ messageId: string }> {
    const session = await this.require(sessionId);
    if (this.#runs.has(sessionId)) {
      throw new SessionBusyError(sessionId);
    }
    const recent = await this.#recentMessages(sessionId, 200);
    const offer = recent.at(-1);
    const target = offer?.notice?.state === "offered" ? offer.notice.to : null;
    const current = session.providerId ? this.#providers.get(session.providerId) : undefined;
    const next = target ? this.#providers.get(target.providerId) : undefined;
    const userMessage = [...recent].reverse().find((message) => message.role === "user");
    if (!offer?.notice || !target || !current || !next || !userMessage || familyOf(current) !== familyOf(next)) {
      throw new Error("This chat has no other account waiting to go on");
    }

    const placeholder: ActiveRun = {
      handle: { sessionId, providerSessionId: session.providerSessionId ?? sessionId },
      adapter: next,
      cancelled: false,
      finished: Promise.resolve(),
    };
    this.#runs.set(sessionId, placeholder);
    try {
      const moved = await this.#moveToAccount(session, current, next);
      const notice: AccountNotice = {
        ...offer.notice,
        state: "switched",
        carried: await this.#carriedHow(moved.adopted, userMessage),
      };
      await this.#updateNotice(offer, notice);
      return await this.#startTurn(moved.session, next, target.providerId, placeholder, userMessage);
    } catch (error) {
      if (this.#runs.get(sessionId) === placeholder) {
        this.#runs.delete(sessionId);
      }
      throw error;
    }
  }

  /**
   * Answers a message already in the chat: starts or resumes the provider
   * session, and — when the tool starts this conversation fresh although the
   * chat has history — hands the earlier conversation over with it.
   */
  async #startTurn(
    session: Session,
    adapter: AIProviderAdapter,
    providerId: string,
    placeholder: ActiveRun,
    userMessage: ChatMessage,
  ): Promise<{ messageId: string }> {
    const sessionId = session.id;
    let resolved: { handle: ProviderSessionHandle; fresh: boolean };
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
        providerId,
        modelId: session.modelId,
      });
      this.#events.publish({ type: "message.created", message: failed });
      if (this.#runs.get(sessionId) === placeholder) {
        this.#runs.delete(sessionId);
      }
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
        providerId,
        modelId: session.modelId,
      });
      this.#events.publish({ type: "message.created", message: cancelled });
      if (this.#runs.get(sessionId) === placeholder) {
        this.#runs.delete(sessionId);
      }
      throw new Error("cancelled");
    }
    const text = resolved.fresh ? await this.#withHandover(userMessage) : userMessage.content;
    const assistantMessage = await this.#insertMessage({
      sessionId,
      role: "assistant",
      content: "",
      status: "streaming",
      providerId,
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
    const sent = userMessage.attachments;
    const message = {
      text,
      ...(sent.length > 0
        ? { attachments: sent.map(({ kind, path }) => ({ kind, path })) }
        : {}),
    };
    const endDiff = await this.#watchFolder(session.workingDirectory, assistantMessage.id);
    run.finished = this.#stream(run, providerId, assistantMessage, message, userMessage, endDiff).finally(
      () => {
        // A turn that went on on another account has registered its own run.
        if (this.#runs.get(sessionId) === run) {
          this.#runs.delete(sessionId);
        }
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
    // A provider that never settles its stream would otherwise leave the
    // session busy forever: no new message, no delete, UI frozen. Retire it
    // here; a late stream end finds its entry gone and only writes its
    // already-persisted answer, never resurrecting the busy state.
    if (this.#runs.get(sessionId) === run) {
      this.#runs.delete(sessionId);
      this.#logger.warn("Provider did not settle after cancel; session retired", {
        sessionId,
      });
      this.#publishStatus(sessionId, "idle");
    }
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
    userMessage: ChatMessage,
    endDiff: () => Promise<TurnDiff | undefined>,
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

    const turnDiff = await endDiff();
    const finalMessage: ChatMessage = {
      ...message,
      content,
      status,
      toolCalls,
      usage,
      error: error?.message ?? null,
      updatedAt: new Date(),
      ...(turnDiff ? { turnDiff } : {}),
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
        turnDiff: turnDiff ?? null,
      })
      .where(eq(chatMessages.id, message.id));

    await this.#touchSession(sessionId);

    // A session that still has its generated name takes the topic of its
    // first exchange, so past conversations stay findable. Renamed sessions
    // are never touched.
    if (status === "complete") {
      // The account answered, so whatever limit it reported is over.
      this.#limited.delete(providerId);
      await this.#nameFromFirstExchange(sessionId, userMessage.content).catch((error: unknown) => {
        this.#logger.debug("Session could not be named from its first turn", {
          sessionId,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }

    // A turn that ended at a limit keeps the session claimed while the next
    // account is chosen, so no other message slips in between.
    const atLimit = status === "failed" && error?.kind === "rateLimit" && !run.cancelled;

    // The run is retired before the terminal events are published, so anything
    // reacting to the finished answer already sees an idle session and may send
    // the next message immediately.
    if (!atLimit && this.#runs.get(sessionId) === run) {
      this.#runs.delete(sessionId);
    }

    this.#events.publish({ type: "message.updated", message: finalMessage });
    if (error) {
      this.#events.publish({
        type: "message.failed",
        sessionId,
        messageId: message.id,
        error,
      });
    }
    if (atLimit && error) {
      const limit = error;
      const wentOn = await this.#atLimit(run, providerId, userMessage, limit, usage).catch((caught: unknown) => {
        this.#logger.warn("Going on after a limit failed", {
          sessionId,
          error: caught instanceof Error ? caught.message : String(caught),
        });
        return false;
      });
      if (wentOn) {
        return;
      }
      if (this.#runs.get(sessionId) === run) {
        this.#runs.delete(sessionId);
      }
    }
    this.#publishStatus(sessionId, status === "failed" ? "error" : "idle");
  }

  /**
   * An account reached its limit. Depending on the person's choice the chat
   * goes on on the tool's next free account, offers it, or stops — and says
   * which in a line of its own. Never another tool, never an account that is
   * at its limit too. True when the turn went on elsewhere.
   */
  async #atLimit(
    run: ActiveRun,
    providerId: string,
    userMessage: ChatMessage,
    error: NormalizedProviderError,
    turnUsage: MessageUsage | null,
  ): Promise<boolean> {
    const sessionId = userMessage.sessionId;
    const now = Date.now();
    const snapshots = this.#snapshots();
    // When the limit ends, as the tool said it: with the error, in the limits
    // it reported during this turn, or in its last usage report.
    const reported = turnUsage
      ? exhaustedUntil(
          { providerId, state: "available", limits: turnUsage.limits, updatedAt: new Date(now), source: "provider" },
          now,
        )
      : undefined;
    const until = error.resetsAt ?? reported ?? exhaustedUntil(snapshots.get(providerId), now) ?? null;
    this.#limited.set(providerId, { until });
    this.#usage?.invalidate();

    const current = this.#providers.get(providerId);
    if (!current) {
      return false;
    }
    const order = await this.#accountOrder(current, snapshots, now);
    const base = {
      kind: "account" as const,
      tool: current.metadata.displayName,
      from: { providerId, label: accountLabel(current) },
      reason: error.message,
    };
    const action = (await this.#settings?.get().catch(() => null))?.limitAction ?? "stop";
    if (action === "stop") {
      await this.#addNotice(
        sessionId,
        { ...base, state: "stopped", to: null, resetsAt: until, carried: null },
        `${base.from.label} reached its limit. Going on with another account is off in Settings.`,
      );
      return false;
    }
    const { next, earliestReset } = pickNextAccount(order, providerId, now);
    if (!next) {
      await this.#addNotice(
        sessionId,
        { ...base, state: "stopped", to: null, resetsAt: earliestReset, carried: null },
        order.length > 1
          ? `${base.from.label} reached its limit, and so has every other account of ${base.tool}.`
          : `${base.from.label} reached its limit, and ${base.tool} has no other account here.`,
      );
      return false;
    }
    const to = { providerId: next.providerId, label: next.label };
    if (action === "ask" || run.cancelled) {
      await this.#addNotice(sessionId, { ...base, state: "offered", to, resetsAt: until, carried: null });
      return false;
    }

    const nextAdapter = this.#providers.get(next.providerId);
    const session = await this.get(sessionId);
    if (!nextAdapter || !session) {
      return false;
    }
    const placeholder: ActiveRun = {
      handle: { sessionId, providerSessionId: session.providerSessionId ?? sessionId },
      adapter: nextAdapter,
      cancelled: false,
      finished: Promise.resolve(),
    };
    this.#runs.set(sessionId, placeholder);
    try {
      const moved = await this.#moveToAccount(session, current, nextAdapter);
      await this.#addNotice(sessionId, {
        ...base,
        state: "switched",
        to,
        resetsAt: until,
        carried: await this.#carriedHow(moved.adopted, userMessage),
      });
      await this.#startTurn(moved.session, nextAdapter, next.providerId, placeholder, userMessage);
    } catch (caught) {
      // The failure is already in the chat as an answer; the session is free.
      this.#logger.warn("The next account could not take the turn", {
        sessionId,
        providerId: next.providerId,
        error: caught instanceof Error ? caught.message : String(caught),
      });
      if (this.#runs.get(sessionId) === placeholder) {
        this.#runs.delete(sessionId);
      }
      this.#publishStatus(sessionId, "error");
    }
    return true;
  }

  /** The tool's accounts in the order they are tried, with their standing. */
  async #accountOrder(
    current: AIProviderAdapter,
    snapshots: ReadonlyMap<string, ProviderUsageSnapshot>,
    now: number,
  ): Promise<AccountStanding[]> {
    const family = familyOf(current);
    const order: AccountStanding[] = [];
    for (const adapter of this.#providers.registry.list()) {
      const id = adapter.metadata.id;
      if (familyOf(adapter) !== family || !this.#providers.isProviderEnabled(id)) {
        continue;
      }
      if (id !== current.metadata.id && !(await signedIn(adapter))) {
        continue;
      }
      const recorded = this.#limited.get(id);
      const exhausted = exhaustedUntil(snapshots.get(id), now);
      const limited =
        recorded && (recorded.until === null || recorded.until.getTime() > now)
          ? recorded
          : exhausted === undefined
            ? null
            : { until: exhausted };
      order.push({ providerId: id, label: accountLabel(adapter), limited });
    }
    return order;
  }

  /** The last usage the tools reported, by provider; never waits on a tool. */
  #snapshots(): Map<string, ProviderUsageSnapshot> {
    const usage = this.#usage?.latest();
    return new Map((usage?.snapshots ?? []).map((snapshot) => [snapshot.providerId, snapshot]));
  }

  /**
   * Points the chat at another account of the same tool. Where the tool keeps
   * its conversation in the account's home, it moves along and resumes
   * there; otherwise the next turn starts fresh and gets the handover.
   */
  async #moveToAccount(
    session: Session,
    current: AIProviderAdapter,
    next: AIProviderAdapter,
  ): Promise<{ session: Session; adopted: boolean }> {
    let providerSessionId: string | null = null;
    if (session.providerSessionId && current.exportSession && next.importSession) {
      try {
        const transcript = await current.exportSession(session.providerSessionId);
        if (transcript && (await next.importSession(transcript))) {
          providerSessionId = session.providerSessionId;
        }
      } catch (error) {
        this.#logger.warn("The conversation could not move to the other account; it is handed over instead", {
          sessionId: session.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    const updatedAt = new Date();
    const moved: Session = { ...session, providerId: next.metadata.id, providerSessionId, updatedAt };
    await this.#db
      .update(sessions)
      .set({ providerId: moved.providerId, providerSessionId, updatedAt })
      .where(eq(sessions.id, session.id));
    this.#events.publish({ type: "session.updated", session: moved });
    return { session: moved, adopted: providerSessionId !== null };
  }

  async #carriedHow(adopted: boolean, userMessage: ChatMessage): Promise<AccountNotice["carried"]> {
    if (adopted) {
      return "native";
    }
    return buildHandover(await this.#earlierThan(userMessage)) ? "handover" : null;
  }

  async #addNotice(sessionId: string, notice: AccountNotice, content = describeNotice(notice)): Promise<void> {
    const message = await this.#insertMessage({
      sessionId,
      role: "system",
      content,
      status: "complete",
      providerId: null,
      modelId: null,
      notice,
    });
    this.#events.publish({ type: "message.created", message });
  }

  async #updateNotice(message: ChatMessage, notice: AccountNotice): Promise<void> {
    const updated: ChatMessage = { ...message, content: describeNotice(notice), notice, updatedAt: new Date() };
    await this.#db
      .update(chatMessages)
      .set({ content: updated.content, notice, updatedAt: updated.updatedAt })
      .where(eq(chatMessages.id, message.id));
    this.#events.publish({ type: "message.updated", message: updated });
  }

  /** The newest messages of a chat, oldest first. */
  async #recentMessages(sessionId: string, limit: number): Promise<ChatMessage[]> {
    const rows = await this.#db
      .select()
      .from(chatMessages)
      .where(eq(chatMessages.sessionId, sessionId))
      .orderBy(desc(chatMessages.createdAt))
      .limit(limit);
    return rows.map(toChatMessage).reverse();
  }

  /** What was said before a message, as far as a handover would carry it. */
  async #earlierThan(userMessage: ChatMessage): Promise<ChatMessage[]> {
    const at = userMessage.createdAt.getTime();
    return (await this.#recentMessages(userMessage.sessionId, 120)).filter(
      (message) => message.id !== userMessage.id && message.createdAt.getTime() <= at,
    );
  }

  /** The message as the tool receives it, with the earlier conversation first. */
  async #withHandover(userMessage: ChatMessage): Promise<string> {
    const handover = buildHandover(await this.#earlierThan(userMessage));
    return handover ? `${handover}\n\n${userMessage.content}` : userMessage.content;
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
    onDemand: boolean,
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
      // With the skills server the session lists its skills and loads one
      // when needed; the server already offers the ones on for everyone.
      if (onDemand) {
        return this.#skills.buildListing(effective, await this.#skills.globallyEnabled());
      }
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
      return await this.#mcp.toolAccess(
        capabilities,
        await this.#mcp.enabledForSession(session.id),
      );
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
  ): Promise<{ handle: ProviderSessionHandle; fresh: boolean }> {
    const capabilities = await this.#safeCapabilities(adapter);
    const toolAccess = await this.#buildToolAccess(session, capabilities);
    // Skills, then what the session's servers say about using them — so the
    // shared memory and every other server is used without being asked.
    const mcp = this.#mcp;
    const skillsServerId = this.#skillsServerId;
    const onDemand = Boolean(
      skillsServerId && toolAccess?.mcpServers.some((server) => server.id === skillsServerId),
    );
    const systemInstructions = withServerGuidance(
      await this.#buildSystemInstructions(session, capabilities, onDemand),
      toolAccess,
      mcp ? (ids) => mcp.instructionsFor(ids) : undefined,
    );
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
    // A conversation the tool starts now knows nothing of what came before.
    const fresh = info === null;
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
      fresh,
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
    notice?: AccountNotice;
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
      notice: input.notice ?? null,
      turnDiff: null,
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
  const notice = row.notice ? accountNoticeSchema.safeParse(row.notice) : null;
  const turnDiff = row.turnDiff ? turnDiffSchema.safeParse(row.turnDiff) : null;
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
    ...(notice?.success ? { notice: notice.data } : {}),
    ...(turnDiff?.success ? { turnDiff: turnDiff.data } : {}),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** The tool family an entry belongs to; every account of a tool shares it. */
function familyOf(adapter: AIProviderAdapter): string {
  return adapter.metadata.family ?? adapter.metadata.id;
}

/** How a notice names an account: its own label, or the tool for its default one. */
function accountLabel(adapter: AIProviderAdapter): string {
  return adapter.metadata.account?.label ?? adapter.metadata.displayName;
}

/**
 * Whether an account is signed in as far as the tool says; one that plainly
 * is not is never switched to. Asking may run the tool, so it is bounded.
 */
async function signedIn(adapter: AIProviderAdapter): Promise<boolean> {
  const status = await Promise.race([
    adapter.getAuthenticationStatus().catch(() => null),
    new Promise<null>((resolve) => setTimeout(() => resolve(null), 5_000)),
  ]);
  return status?.state !== "authenticationRequired" && status?.state !== "authenticationExpired";
}

/** The notice in plain words; the reset time is added where it is shown. */
function describeNotice(notice: AccountNotice): string {
  switch (notice.state) {
    case "switched":
      return `Continued on ${notice.to?.label ?? "another account"} — ${notice.from.label} reached its limit.`;
    case "offered":
      return `${notice.from.label} reached its limit. ${notice.to?.label ?? "Another account"} of ${notice.tool} is free to go on.`;
    case "stopped":
      return `${notice.from.label} reached its limit.`;
  }
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
