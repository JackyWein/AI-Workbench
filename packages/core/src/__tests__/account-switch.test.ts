import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeTempDirectory, removeTempDirectory } from "@ai-workbench/test-support";
import { createDatabase, runMigrations, type DatabaseHandle } from "@ai-workbench/database";
import { mockProviderFactory } from "@ai-workbench/provider-mock";
import type { AppEvent, ChatMessage, LimitAction, ProviderUsageSnapshot } from "@ai-workbench/shared";
import { buildHandover, exhaustedUntil, pickNextAccount, type AccountStanding } from "../account-switch.js";
import { EventBus } from "../event-bus.js";
import { createNullLogger } from "../logger.js";
import { ProviderManager } from "../provider-manager.js";
import { SessionManager } from "../session-manager.js";
import { UsageService } from "../usage-service.js";
import { WorkspaceManager } from "../workspace-manager.js";

const NOW = Date.parse("2026-09-25T12:00:00Z");
const free = (providerId: string): AccountStanding => ({ providerId, label: providerId, limited: null });
const limited = (providerId: string, until: string | null): AccountStanding => ({
  providerId,
  label: providerId,
  limited: { until: until === null ? null : new Date(until) },
});

describe("choosing the next account", () => {
  it("goes round the tool's accounts in order, starting after the current one", () => {
    const order = [free("work"), free("private"), free("team")];
    expect(pickNextAccount(order, "private", NOW).next?.providerId).toBe("team");
    expect(pickNextAccount(order, "team", NOW).next?.providerId).toBe("work");
  });

  it("never picks an account that is at its limit", () => {
    const order = [free("work"), limited("private", "2026-09-25T14:30:00Z"), limited("team", null), free("spare")];
    expect(pickNextAccount(order, "work", NOW).next?.providerId).toBe("spare");
  });

  it("counts a limit whose reset has passed as over", () => {
    const order = [free("work"), limited("private", "2026-09-25T11:00:00Z")];
    expect(pickNextAccount(order, "work", NOW).next?.providerId).toBe("private");
  });

  it("stops at the last account and says when the earliest limit resets", () => {
    const order = [
      limited("work", "2026-09-25T17:00:00Z"),
      limited("private", "2026-09-25T14:30:00Z"),
      limited("team", null),
    ];
    const answer = pickNextAccount(order, "work", NOW);
    expect(answer.next).toBeNull();
    expect(answer.earliestReset?.toISOString()).toBe("2026-09-25T14:30:00.000Z");
    expect(pickNextAccount([limited("work", null)], "work", NOW)).toEqual({ next: null, earliestReset: null });
  });
});

describe("reading a limit from reported usage", () => {
  const snapshot = (limits: ProviderUsageSnapshot["limits"]): ProviderUsageSnapshot => ({
    providerId: "work",
    state: "available",
    limits,
    updatedAt: new Date(NOW),
    source: "provider",
  });

  it("finds a used-up window and its reset, and ignores ones that reset already", () => {
    expect(
      exhaustedUntil(
        snapshot([
          { id: "5h", label: "5 hours", unit: "percent", used: 100, resetsAt: new Date("2026-09-25T14:30:00Z") },
          { id: "week", label: "Week", unit: "percent", used: 40 },
        ]),
        NOW,
      )?.toISOString(),
    ).toBe("2026-09-25T14:30:00.000Z");
    expect(
      exhaustedUntil(
        snapshot([{ id: "5h", label: "5 hours", unit: "percent", used: 100, resetsAt: new Date(NOW - 1) }]),
        NOW,
      ),
    ).toBeUndefined();
    expect(exhaustedUntil(snapshot([{ id: "r", label: "Requests", unit: "requests", used: 250, total: 250 }]), NOW)).toBeNull();
    expect(exhaustedUntil(snapshot([{ id: "5h", label: "5 hours", unit: "percent", used: 99 }]), NOW)).toBeUndefined();
    expect(exhaustedUntil(undefined, NOW)).toBeUndefined();
  });
});

describe("handing the conversation over", () => {
  const message = (role: ChatMessage["role"], content: string, status: ChatMessage["status"] = "complete"): ChatMessage => ({
    id: `${role}-${content}`,
    sessionId: "s",
    role,
    content,
    status,
    providerId: null,
    modelId: null,
    toolCalls: [],
    attachments: [],
    usage: null,
    error: null,
    createdAt: new Date(NOW),
    updatedAt: new Date(NOW),
  });

  it("carries the person's turns and the answers, leaving out failures and notices", () => {
    const handover = buildHandover([
      message("user", "Remember the word heron."),
      message("assistant", "Noted: heron."),
      message("user", "And now?"),
      message("assistant", "limit reached", "failed"),
      message("system", "Continued on Private"),
    ]);
    expect(handover).toContain("[person]\nRemember the word heron.");
    expect(handover).toContain("[assistant]\nNoted: heron.");
    expect(handover).not.toContain("limit reached");
    expect(handover).not.toContain("Continued on Private");
  });

  it("keeps the newest part of a long conversation and says what was left out", () => {
    const long = Array.from({ length: 60 }, (_, index) => message("user", `turn ${index}`));
    const handover = buildHandover(long) ?? "";
    expect(handover).toContain("turn 59");
    expect(handover).not.toContain("turn 0\n");
    expect(handover).toContain("(20 earlier messages are not included.)");
  });

  it("has nothing to hand over for a new conversation", () => {
    expect(buildHandover([])).toBeNull();
  });
});

describe("a chat at its account's limit", () => {
  let directory: string;
  let database: DatabaseHandle;
  let providers: ProviderManager;
  let sessions: SessionManager;
  let workspaces: WorkspaceManager;
  let events: EventBus;
  let action: LimitAction;

  beforeEach(async () => {
    directory = await makeTempDirectory("account-switch-");
    const logger = createNullLogger();
    database = createDatabase({ file: join(directory, "test.db") });
    await runMigrations(database.client);
    events = new EventBus();
    providers = new ProviderManager({ logger, stateDirectory: join(directory, "providers") });
    await providers.registerFactory(mockProviderFactory({ chunkDelayMs: 0, startupDelayMs: 0 }));
    await providers.addAccount("mock", { id: "spare", label: "Spare", home: null });
    workspaces = new WorkspaceManager({ db: database.db, events, logger });
    action = "switch";
    sessions = new SessionManager({
      db: database.db,
      events,
      logger,
      providers,
      workspaces,
      usage: new UsageService({ providers, events, logger }),
      settings: { get: async () => ({ limitAction: action }) },
    });
  });

  afterEach(async () => {
    await sessions.shutdown();
    await providers.dispose();
    database.close();
    await removeTempDirectory(directory);
  });

  const startChat = async () => {
    const workspace = await workspaces.create({ name: "Work", path: directory });
    return sessions.create({ workspaceId: workspace.id, name: "Chat", type: "solo", providerId: "mock" });
  };

  /** Resolves when the session is idle again and nothing new is starting. */
  const settle = async (sessionId: string): Promise<ChatMessage[]> => {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      const messages = await sessions.listMessages(sessionId);
      if (!sessions.isBusy(sessionId) && messages.every((message) => message.status !== "streaming")) {
        return messages;
      }
    }
    throw new Error("the chat never settled");
  };

  it("goes on on the next account with the earlier conversation, and says so", async () => {
    const session = await startChat();
    await sessions.sendMessage(session.id, "Remember the word heron.");
    await settle(session.id);

    const seen: AppEvent[] = [];
    events.subscribe((event) => seen.push(event));
    await sessions.sendMessage(session.id, "/limit@mock /recall");
    const messages = await settle(session.id);

    const notice = messages.find((message) => message.notice);
    expect(notice?.role).toBe("system");
    expect(notice?.notice).toMatchObject({
      state: "switched",
      tool: "Mock Provider",
      from: { providerId: "mock", label: "Mock Provider" },
      to: { providerId: "mock@spare", label: "Spare" },
      carried: "handover",
      reason: "Simulated account limit reached",
    });
    expect(notice?.notice?.resetsAt).toBeInstanceOf(Date);

    const answer = messages.at(-1);
    expect(answer?.role).toBe("assistant");
    expect(answer?.status).toBe("complete");
    expect(answer?.providerId).toBe("mock@spare");
    // The spare account was given what was said before it took over.
    expect(answer?.content).toContain("Remember the word heron.");
    expect((await sessions.require(session.id)).providerId).toBe("mock@spare");
    // The person's message is not repeated in the chat.
    expect(messages.filter((message) => message.role === "user")).toHaveLength(2);
    expect(seen.some((event) => event.type === "session.updated" && event.session.providerId === "mock@spare")).toBe(true);
  });

  it("offers the next account when asked to, and goes on there on request", async () => {
    action = "ask";
    const session = await startChat();
    await sessions.sendMessage(session.id, "Remember the word heron.");
    await settle(session.id);
    await sessions.sendMessage(session.id, "/limit@mock /recall");
    let messages = await settle(session.id);

    expect(messages.at(-1)?.notice).toMatchObject({ state: "offered", to: { providerId: "mock@spare" } });
    expect((await sessions.require(session.id)).providerId).toBe("mock");

    await sessions.continueOnAccount(session.id);
    messages = await settle(session.id);
    const notices = messages.filter((message) => message.notice);
    expect(notices).toHaveLength(1);
    expect(notices[0]?.notice?.state).toBe("switched");
    expect(messages.at(-1)?.providerId).toBe("mock@spare");
    expect(messages.at(-1)?.content).toContain("Remember the word heron.");
    await expect(sessions.continueOnAccount(session.id)).rejects.toThrow(/no other account/);
  });

  it("stops when switching is off, and says when the limit resets", async () => {
    action = "stop";
    const session = await startChat();
    await sessions.sendMessage(session.id, "/limit@mock hello");
    const messages = await settle(session.id);
    const notice = messages.at(-1)?.notice;
    expect(notice).toMatchObject({ state: "stopped", to: null });
    expect(notice?.resetsAt).toBeInstanceOf(Date);
    expect(messages.at(-1)?.content).toContain("off in Settings");
    expect((await sessions.require(session.id)).providerId).toBe("mock");
  });

  it("stops at the last account instead of switching into one at its limit", async () => {
    const session = await startChat();
    // Both accounts hit their limit in one message: the spare one too, after
    // the chat moved there.
    await sessions.sendMessage(session.id, "/limit@mock /limit@mock@spare hello");
    const messages = await settle(session.id);
    const notices = messages.filter((message) => message.notice).map((message) => message.notice);
    expect(notices.map((notice) => notice?.state)).toEqual(["switched", "stopped"]);
    expect(notices[1]?.to).toBeNull();
    expect(notices[1]?.resetsAt).toBeInstanceOf(Date);
    expect(messages.at(-1)?.content).toContain("every other account of Mock Provider");
  });
});
