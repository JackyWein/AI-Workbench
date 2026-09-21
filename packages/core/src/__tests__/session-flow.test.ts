import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDatabase, runMigrations, type DatabaseHandle } from "@ai-workbench/database";
import { MockProviderAdapter } from "@ai-workbench/provider-mock";
import type { AppEvent, ChatMessage } from "@ai-workbench/shared";
import { EventBus } from "../event-bus.js";
import { createNullLogger } from "../logger.js";
import { ProviderManager } from "../provider-manager.js";
import { SessionManager } from "../session-manager.js";
import { SettingsService } from "../settings-service.js";
import { UsageService } from "../usage-service.js";
import { WorkspaceManager } from "../workspace-manager.js";

interface TestApp {
  readonly events: EventBus;
  readonly database: DatabaseHandle;
  readonly workspaces: WorkspaceManager;
  readonly sessions: SessionManager;
  readonly usage: UsageService;
  readonly settings: SettingsService;
  dispose(): Promise<void>;
}

/**
 * Boots the same service graph the main process builds, without Electron.
 * Tests that need a run to still be in flight pass a non-zero chunk delay so
 * the outcome does not depend on scheduling luck.
 */
async function bootApp(
  directory: string,
  mockOptions: { chunkDelayMs?: number; startupDelayMs?: number } = {},
): Promise<TestApp> {
  const logger = createNullLogger();
  const database = createDatabase({ file: join(directory, "test.db") });
  await runMigrations(database.client);

  const events = new EventBus();
  const providers = new ProviderManager({
    logger,
    stateDirectory: join(directory, "providers"),
  });
  await providers.register(
    new MockProviderAdapter({
      chunkDelayMs: mockOptions.chunkDelayMs ?? 0,
      startupDelayMs: mockOptions.startupDelayMs ?? 0,
    }),
  );

  const workspaces = new WorkspaceManager({ db: database.db, events, logger });
  const sessions = new SessionManager({
    db: database.db,
    events,
    logger,
    providers,
    workspaces,
  });

  return {
    events,
    database,
    workspaces,
    sessions,
    usage: new UsageService({ providers, events, logger }),
    settings: new SettingsService({ db: database.db, logger }),
    dispose: async () => {
      await sessions.shutdown();
      await providers.dispose();
      database.close();
    },
  };
}

/** Resolves once the given assistant message reaches its final state. */
function waitForMessage(events: EventBus, messageId: string): Promise<ChatMessage> {
  return new Promise((resolve) => {
    const unsubscribe = events.subscribe((event: AppEvent) => {
      if (event.type === "message.updated" && event.message.id === messageId) {
        unsubscribe();
        resolve(event.message);
      }
    });
  });
}

describe("session vertical slice", () => {
  let directory: string;
  let app: TestApp;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "ai-workbench-"));
    app = await bootApp(directory);
  });

  afterEach(async () => {
    await app.dispose();
    await rm(directory, { recursive: true, force: true });
  });

  it("creates a workspace and a session with sensible defaults", async () => {
    const workspace = await app.workspaces.create({ name: "Demo", path: directory });
    const session = await app.sessions.create({
      workspaceId: workspace.id,
      name: "First",
      type: "solo",
    });

    expect(session.workingDirectory).toBe(workspace.path);
    // The registry supplies the provider; nothing here names one.
    expect(session.providerId).toBe("mock");
    expect(session.providerSessionId).toBeNull();
  });

  it("rejects a workspace path that is not a directory", async () => {
    await expect(
      app.workspaces.create({ name: "Broken", path: join(directory, "missing") }),
    ).rejects.toThrow(/not usable/);
  });

  it("keeps a session inside its workspace", async () => {
    const workspace = await app.workspaces.create({ name: "Demo", path: directory });
    await expect(
      app.sessions.create({
        workspaceId: workspace.id,
        name: "Escape",
        type: "solo",
        workingDirectory: "../elsewhere",
      }),
    ).rejects.toThrow(/outside the permitted root/);
  });

  it("streams a response, persists it and records usage", async () => {
    const workspace = await app.workspaces.create({ name: "Demo", path: directory });
    const session = await app.sessions.create({
      workspaceId: workspace.id,
      name: "Chat",
      type: "solo",
    });

    const deltas: string[] = [];
    app.events.subscribe((event) => {
      if (event.type === "message.delta") {
        deltas.push(event.text);
      }
    });

    const { messageId } = await app.sessions.sendMessage(session.id, "hello there");
    const finished = await waitForMessage(app.events, messageId);

    expect(deltas.length).toBeGreaterThan(1);
    expect(finished.status).toBe("complete");
    expect(finished.content).toContain("hello there");
    expect(finished.usage?.outputTokens).toBeGreaterThan(0);

    const stored = await app.sessions.listMessages(session.id);
    expect(stored).toHaveLength(2);
    expect(stored[0]?.role).toBe("user");
    expect(stored[1]?.content).toBe(finished.content);

    const usage = await app.usage.get();
    const snapshot = usage.snapshots.find((entry) => entry.providerId === "mock");
    expect(snapshot?.state).toBe("available");
    expect(snapshot?.limits[0]?.used).toBe(1);
  });

  it("stops a response on request and keeps what arrived", async () => {
    const slowDirectory = await mkdtemp(join(tmpdir(), "ai-workbench-slow-"));
    const slowApp = await bootApp(slowDirectory, {
      chunkDelayMs: 8,
      startupDelayMs: 8,
    });
    try {
      const workspace = await slowApp.workspaces.create({ name: "Demo", path: directory });
      const session = await slowApp.sessions.create({
        workspaceId: workspace.id,
        name: "Chat",
        type: "solo",
      });

      const { messageId } = await slowApp.sessions.sendMessage(session.id, "long answer");
      const finished = waitForMessage(slowApp.events, messageId);
      await slowApp.sessions.cancel(session.id);
      const message = await finished;

      expect(message.status).toBe("cancelled");
      expect(slowApp.sessions.isBusy(session.id)).toBe(false);

      // The partial turn is still part of the conversation.
      const stored = await slowApp.sessions.listMessages(session.id);
      expect(stored.at(-1)?.status).toBe("cancelled");
    } finally {
      await slowApp.dispose();
      await rm(slowDirectory, { recursive: true, force: true });
    }
  });

  it("records a provider failure without breaking the session", async () => {
    const workspace = await app.workspaces.create({ name: "Demo", path: directory });
    const session = await app.sessions.create({
      workspaceId: workspace.id,
      name: "Chat",
      type: "solo",
    });

    const { messageId } = await app.sessions.sendMessage(session.id, "now /error");
    const failed = await waitForMessage(app.events, messageId);

    expect(failed.status).toBe("failed");
    expect(failed.error).toContain("Simulated");

    // The session remains usable afterwards.
    const second = await app.sessions.sendMessage(session.id, "and now normally");
    const recovered = await waitForMessage(app.events, second.messageId);
    expect(recovered.status).toBe("complete");
  });

  it("refuses a second message while one is in flight", async () => {
    const busyDirectory = await mkdtemp(join(tmpdir(), "ai-workbench-busy-"));
    const busyApp = await bootApp(busyDirectory, {
      chunkDelayMs: 8,
      startupDelayMs: 8,
    });
    try {
      const workspace = await busyApp.workspaces.create({
        name: "Demo",
        path: directory,
      });
      const session = await busyApp.sessions.create({
        workspaceId: workspace.id,
        name: "Chat",
        type: "solo",
      });

      const { messageId } = await busyApp.sessions.sendMessage(session.id, "first");
      await expect(busyApp.sessions.sendMessage(session.id, "second")).rejects.toThrow(
        /still responding/,
      );
      await waitForMessage(busyApp.events, messageId);
    } finally {
      await busyApp.dispose();
      await rm(busyDirectory, { recursive: true, force: true });
    }
  });

  it("continues the same session after a restart", async () => {
    const workspace = await app.workspaces.create({ name: "Demo", path: directory });
    const session = await app.sessions.create({
      workspaceId: workspace.id,
      name: "Chat",
      type: "solo",
    });

    const first = await app.sessions.sendMessage(session.id, "before restart");
    await waitForMessage(app.events, first.messageId);

    const beforeRestart = await app.sessions.get(session.id);
    expect(beforeRestart?.providerSessionId).not.toBeNull();

    await app.dispose();

    // Same database file, fresh services: this is the restart.
    app = await bootApp(directory);

    const workspacesAfter = await app.workspaces.list();
    expect(workspacesAfter.map((entry) => entry.id)).toContain(workspace.id);

    const restored = await app.sessions.get(session.id);
    expect(restored?.providerSessionId).toBe(beforeRestart?.providerSessionId);

    const history = await app.sessions.listMessages(session.id);
    expect(history).toHaveLength(2);
    expect(history[0]?.content).toBe("before restart");

    const second = await app.sessions.sendMessage(session.id, "after restart");
    const continued = await waitForMessage(app.events, second.messageId);
    expect(continued.status).toBe("complete");

    // The provider session id survived, so the conversation was resumed rather
    // than restarted.
    const afterSecond = await app.sessions.get(session.id);
    expect(afterSecond?.providerSessionId).toBe(beforeRestart?.providerSessionId);
    expect(await app.sessions.listMessages(session.id)).toHaveLength(4);
  });

  it("deletes a workspace together with its sessions and messages", async () => {
    const workspace = await app.workspaces.create({ name: "Demo", path: directory });
    const session = await app.sessions.create({
      workspaceId: workspace.id,
      name: "Chat",
      type: "solo",
    });
    const { messageId } = await app.sessions.sendMessage(session.id, "hello");
    await waitForMessage(app.events, messageId);

    expect(await app.workspaces.delete(workspace.id)).toBe(true);
    expect(await app.sessions.get(session.id)).toBeNull();
    expect(await app.sessions.listMessages(session.id)).toHaveLength(0);
  });

  it("persists settings across a restart", async () => {
    await app.settings.update({ theme: "light", developerMode: true });
    await app.dispose();
    app = await bootApp(directory);

    const settings = await app.settings.get();
    expect(settings.theme).toBe("light");
    expect(settings.developerMode).toBe(true);
    expect(settings.density).toBe("comfortable");
  });
});
