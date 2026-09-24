import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeTempDirectory, removeTempDirectory } from "@ai-workbench/test-support";
import { createDatabase, runMigrations, type DatabaseHandle } from "@ai-workbench/database";
import { MockProviderAdapter } from "@ai-workbench/provider-mock";
import type { AppEvent, ChatMessage, ProviderEvent } from "@ai-workbench/shared";
import { EventBus } from "../event-bus.js";
import { AttachmentError } from "../attachments.js";
import { createNullLogger } from "../logger.js";
import { ProviderManager } from "../provider-manager.js";
import { SessionManager } from "../session-manager.js";
import { SettingsService } from "../settings-service.js";
import { UsageService } from "../usage-service.js";
import { WorkspaceManager } from "../workspace-manager.js";
import { removeWorkspace } from "../workspace-removal.js";

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
  attachmentsDirectory?: string,
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
    ...(attachmentsDirectory ? { attachmentsDirectory } : {}),
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
    directory = await makeTempDirectory("ai-workbench-");
    app = await bootApp(directory);
  });

  afterEach(async () => {
    await app.dispose();
    await removeTempDirectory(directory);
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
    const slowDirectory = await makeTempDirectory("ai-workbench-slow-");
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
      await removeTempDirectory(slowDirectory);
    }
  });

  it("saves a stopped turn as stopped even when the tool finishes it anyway", async () => {
    // A tool that ignores the stop and ends its turn normally, as a command
    // line tool whose process outlives the request can.
    class Stubborn extends MockProviderAdapter {
      override async cancel(): Promise<void> {}
      override async *sendMessage(): AsyncIterable<ProviderEvent> {
        for (const word of ["one ", "two ", "three"]) {
          await new Promise((resolve) => setTimeout(resolve, 60));
          yield { type: "text_delta", text: word };
        }
        yield { type: "completed", reason: "finished" };
      }
    }
    const stubbornDirectory = await makeTempDirectory("ai-workbench-stubborn-");
    const logger = createNullLogger();
    const database = createDatabase({ file: join(stubbornDirectory, "test.db") });
    await runMigrations(database.client);
    const events = new EventBus();
    const providers = new ProviderManager({ logger, stateDirectory: join(stubbornDirectory, "p") });
    await providers.register(new Stubborn({ chunkDelayMs: 0, startupDelayMs: 0 }));
    const workspaces = new WorkspaceManager({ db: database.db, events, logger });
    const sessions = new SessionManager({ db: database.db, events, logger, providers, workspaces });
    try {
      const workspace = await workspaces.create({ name: "Demo", path: directory });
      const session = await sessions.create({ workspaceId: workspace.id, name: "Chat", type: "solo" });
      const { messageId } = await sessions.sendMessage(session.id, "count");
      const finished = waitForMessage(events, messageId);
      // What it is doing is said while it does it.
      const deadline = Date.now() + 2000;
      while (sessions.activity(session.id) !== "writing" && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(sessions.activity(session.id)).toBe("writing");
      await sessions.cancel(session.id);
      expect((await finished).status).toBe("cancelled");
      expect(sessions.activity(session.id)).toBeNull();
    } finally {
      await sessions.shutdown();
      await providers.dispose();
      database.close();
      await removeTempDirectory(stubbornDirectory);
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
    const busyDirectory = await makeTempDirectory("ai-workbench-busy-");
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
      await removeTempDirectory(busyDirectory);
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

  it("runs several sessions at the same time", async () => {
    const workspace = await app.workspaces.create({ name: "Demo", path: directory });
    const first = await app.sessions.create({
      workspaceId: workspace.id,
      name: "First",
      type: "solo",
    });
    const second = await app.sessions.create({
      workspaceId: workspace.id,
      name: "Second",
      type: "solo",
    });

    // Both turns are started before either has finished.
    const firstSend = await app.sessions.sendMessage(first.id, "question one");
    const secondSend = await app.sessions.sendMessage(second.id, "question two");

    const [firstAnswer, secondAnswer] = await Promise.all([
      waitForMessage(app.events, firstSend.messageId),
      waitForMessage(app.events, secondSend.messageId),
    ]);

    expect(firstAnswer.status).toBe("complete");
    expect(secondAnswer.status).toBe("complete");
    expect(firstAnswer.content).toContain("question one");
    expect(secondAnswer.content).toContain("question two");

    // Each conversation kept its own history.
    expect(await app.sessions.listMessages(first.id)).toHaveLength(2);
    expect(await app.sessions.listMessages(second.id)).toHaveLength(2);
  });

  it("records a tool call as part of the answer", async () => {
    const workspace = await app.workspaces.create({ name: "Demo", path: directory });
    const session = await app.sessions.create({
      workspaceId: workspace.id,
      name: "Tools",
      type: "solo",
    });

    const { messageId } = await app.sessions.sendMessage(session.id, "please /tool");
    const answer = await waitForMessage(app.events, messageId);

    expect(answer.toolCalls).toHaveLength(1);
    expect(answer.toolCalls[0]).toMatchObject({
      name: "filesystem",
      state: "completed",
    });

    // The tool call survives a reload, so the UI can collapse it later.
    const stored = await app.sessions.listMessages(session.id);
    expect(stored.at(-1)?.toolCalls).toHaveLength(1);
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

describe("files sent with a message", () => {
  let directory: string;
  let kept: string;
  let app: TestApp;

  beforeEach(async () => {
    directory = await makeTempDirectory("ai-workbench-files-");
    kept = join(directory, "kept");
    app = await bootApp(directory, {}, kept);
  });

  afterEach(async () => {
    await app.dispose();
    await removeTempDirectory(directory);
  });

  it("keeps a copy with the message and hands the copy to the provider", async () => {
    const workspace = await app.workspaces.create({ name: "Demo", path: directory });
    const session = await app.sessions.create({ workspaceId: workspace.id, name: "Chat", type: "solo" });
    const picked = join(directory, "picked");
    await mkdir(picked);
    await writeFile(join(picked, "red dot.png"), "not really a picture");
    await writeFile(join(picked, "notes.txt"), "hello notes");

    const { messageId } = await app.sessions.sendMessage(session.id, "look at these", [
      { path: join(picked, "red dot.png") },
      { path: join(picked, "notes.txt") },
    ]);
    const finished = await waitForMessage(app.events, messageId);
    expect(finished.content).toContain("You attached 2 files: red dot.png (image), notes.txt (file).");

    const [user] = await app.sessions.listMessages(session.id);
    expect(user?.attachments.map(({ name, kind, size }) => ({ name, kind, size }))).toEqual([
      { name: "red dot.png", kind: "image", size: 20 },
      { name: "notes.txt", kind: "file", size: 11 },
    ]);
    const copy = user?.attachments[1]?.path ?? "";
    expect(copy.startsWith(join(kept, session.id))).toBe(true);
    expect(await readFile(copy, "utf8")).toBe("hello notes");

    await app.sessions.delete(session.id);
    expect(existsSync(join(kept, session.id))).toBe(false);
  });

  it("stops a turn in flight and removes its files when the workspace goes", async () => {
    await app.dispose();
    app = await bootApp(directory, { chunkDelayMs: 8, startupDelayMs: 8 }, kept);
    const workspace = await app.workspaces.create({ name: "Demo", path: directory });
    const session = await app.sessions.create({ workspaceId: workspace.id, name: "Chat", type: "solo" });
    const note = join(directory, "note.txt");
    await writeFile(note, "a note");
    const deleted: string[] = [];
    app.events.subscribe((event: AppEvent) => {
      if (event.type === "session.deleted") {
        deleted.push(event.sessionId);
      }
    });

    await app.sessions.sendMessage(session.id, "long answer", [{ path: note }]);
    expect(app.sessions.isBusy(session.id)).toBe(true);
    expect(existsSync(join(kept, session.id))).toBe(true);

    expect(await removeWorkspace(app, workspace.id)).toBe(true);
    expect(app.sessions.isBusy(session.id)).toBe(false);
    expect(deleted).toEqual([session.id]);
    expect(existsSync(join(kept, session.id))).toBe(false);
    expect(await app.workspaces.get(workspace.id)).toBeNull();
    expect(await removeWorkspace(app, workspace.id)).toBe(false);
  });

  it("refuses a file that is gone and leaves the session free", async () => {
    const workspace = await app.workspaces.create({ name: "Demo", path: directory });
    const session = await app.sessions.create({ workspaceId: workspace.id, name: "Chat", type: "solo" });

    await expect(
      app.sessions.sendMessage(session.id, "look", [{ path: join(directory, "missing.png") }]),
    ).rejects.toBeInstanceOf(AttachmentError);
    expect(await app.sessions.listMessages(session.id)).toHaveLength(0);

    const { messageId } = await app.sessions.sendMessage(session.id, "still here");
    expect((await waitForMessage(app.events, messageId)).status).toBe("complete");
  });
});
