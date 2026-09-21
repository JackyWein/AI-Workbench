import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDatabase, runMigrations, type DatabaseHandle } from "@ai-workbench/database";
import { MockProviderAdapter } from "@ai-workbench/provider-mock";
import type { AIProviderAdapter } from "@ai-workbench/provider-base";
import type { AppEvent, ChatMessage, ProviderEvent } from "@ai-workbench/shared";
import { EventBus } from "../event-bus.js";
import { createLogger, createNullLogger } from "../logger.js";
import { ProviderManager } from "../provider-manager.js";
import { SessionManager } from "../session-manager.js";
import { WorkspaceManager } from "../workspace-manager.js";

/**
 * Critical failure paths: a provider that misbehaves must not take the session,
 * the database or the application down with it (spec §60).
 */

function misbehavingAdapter(
  id: string,
  stream: () => AsyncIterable<ProviderEvent>,
): AIProviderAdapter {
  return {
    metadata: {
      id,
      displayName: id,
      adapterVersion: "0.0.1",
      authMethods: ["none"],
      transportTypes: ["in-process"],
    },
    initialize: async () => {},
    dispose: async () => {},
    detectInstallation: async () => ({ state: "installed" }),
    getAuthenticationStatus: async () => ({ state: "notApplicable" }),
    getCapabilities: async () => ({ supported: ["chat", "streaming"] }),
    listModels: async () => [],
    createSession: async () => ({ providerSessionId: `${id}-1`, resumable: false }),
    sendMessage: () => stream(),
    cancel: async () => {},
    destroySession: async () => {},
  } as AIProviderAdapter;
}

function waitForMessage(events: EventBus, messageId: string): Promise<ChatMessage> {
  return new Promise((resolve) => {
    const off = events.subscribe((event: AppEvent) => {
      if (event.type === "message.updated" && event.message.id === messageId) {
        off();
        resolve(event.message);
      }
    });
  });
}

describe("provider failure isolation", () => {
  let directory: string;
  let database: DatabaseHandle;
  let events: EventBus;
  let providers: ProviderManager;
  let sessions: SessionManager;
  let workspaces: WorkspaceManager;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "ai-workbench-resilience-"));
    database = createDatabase({ file: join(directory, "test.db") });
    await runMigrations(database.client);

    const logger = createNullLogger();
    events = new EventBus();
    providers = new ProviderManager({
      logger,
      stateDirectory: join(directory, "providers"),
    });
    await providers.register(
      new MockProviderAdapter({ chunkDelayMs: 0, startupDelayMs: 0 }),
    );
    await providers.register(
      misbehavingAdapter("thrower", async function* () {
        yield { type: "text_delta", text: "partial" };
        throw new Error("provider process died");
      }),
    );
    await providers.register(
      misbehavingAdapter("garbage", async function* () {
        // An adapter that yields something outside the normalized contract.
        yield { type: "text_delta", text: "ok" };
        yield { type: "nonsense", payload: 42 } as unknown as ProviderEvent;
        yield { type: "completed", reason: "finished" };
      }),
    );

    workspaces = new WorkspaceManager({ db: database.db, events, logger });
    sessions = new SessionManager({
      db: database.db,
      events,
      logger,
      providers,
      workspaces,
    });
  });

  afterEach(async () => {
    await sessions.shutdown();
    await providers.dispose();
    database.close();
    await rm(directory, { recursive: true, force: true });
  });

  async function sessionWith(providerId: string): Promise<string> {
    const workspace = await workspaces.create({ name: "Demo", path: directory });
    const session = await sessions.create({
      workspaceId: workspace.id,
      name: "Chat",
      type: "solo",
      providerId,
    });
    return session.id;
  }

  it("survives a provider that throws mid-stream", async () => {
    const sessionId = await sessionWith("thrower");
    const { messageId } = await sessions.sendMessage(sessionId, "hello");
    const message = await waitForMessage(events, messageId);

    expect(message.status).toBe("failed");
    expect(message.error).toContain("provider process died");
    // What did arrive before the failure is kept.
    expect(message.content).toBe("partial");
    expect(sessions.isBusy(sessionId)).toBe(false);
  });

  it("ignores output that is not part of the normalized contract", async () => {
    const sessionId = await sessionWith("garbage");
    const { messageId } = await sessions.sendMessage(sessionId, "hello");
    const message = await waitForMessage(events, messageId);

    expect(message.status).toBe("complete");
    expect(message.content).toBe("ok");
  });

  it("reports a session whose provider is not registered", async () => {
    const workspace = await workspaces.create({ name: "Demo", path: directory });
    const session = await sessions.create({
      workspaceId: workspace.id,
      name: "Chat",
      type: "solo",
      providerId: "not-installed",
    });

    await expect(sessions.sendMessage(session.id, "hello")).rejects.toThrow(
      /no usable provider/,
    );
    // The session itself stays intact and can be pointed at a working provider.
    await sessions.update({ id: session.id, providerId: "mock" });
    const { messageId } = await sessions.sendMessage(session.id, "hello");
    expect((await waitForMessage(events, messageId)).status).toBe("complete");
  });

  it("releases the provider session when a session is deleted", async () => {
    const sessionId = await sessionWith("mock");
    const { messageId } = await sessions.sendMessage(sessionId, "hello");
    await waitForMessage(events, messageId);

    const adapter = providers.get("mock");
    const destroy = vi.spyOn(adapter!, "destroySession");

    expect(await sessions.delete(sessionId)).toBe(true);
    expect(destroy).toHaveBeenCalledTimes(1);
    expect(await sessions.listMessages(sessionId)).toHaveLength(0);
  });

  it("switches provider and model on an existing session", async () => {
    const sessionId = await sessionWith("mock");
    const first = await sessions.sendMessage(sessionId, "hello");
    await waitForMessage(events, first.messageId);

    const updated = await sessions.update({ id: sessionId, modelId: "mock-fast" });
    expect(updated.modelId).toBe("mock-fast");

    const second = await sessions.sendMessage(sessionId, "again");
    const answer = await waitForMessage(events, second.messageId);
    // The selected model is what actually produced the answer.
    expect(answer.content).toContain("mock-fast");

    // Switching provider drops the stale provider-native session id.
    const switched = await sessions.update({ id: sessionId, providerId: "garbage" });
    expect(switched.providerSessionId).toBeNull();
  });
});

describe("logging", () => {
  it("redacts anything that looks like a secret", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ai-workbench-log-"));
    const file = join(directory, "log.json");
    const logger = createLogger({ destinationFile: file, level: "info" });

    logger.child("PROVIDER").info("Configured provider", {
      providerId: "example",
      apiKey: "sk-super-secret",
      nested: { token: "also-secret" },
    });

    // pino writes asynchronously; give the destination a moment to flush.
    await new Promise((resolve) => setTimeout(resolve, 150));
    const contents = await import("node:fs/promises").then((fs) =>
      fs.readFile(file, "utf8"),
    );

    expect(contents).toContain("example");
    expect(contents).not.toContain("sk-super-secret");
    expect(contents).not.toContain("also-secret");
    expect(contents).toContain("[redacted]");

    await rm(directory, { recursive: true, force: true });
  });
});
