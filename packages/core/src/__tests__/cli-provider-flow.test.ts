import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDatabase, runMigrations, type DatabaseHandle } from "@ai-workbench/database";
import { CliProviderAdapter, parseProfile } from "@ai-workbench/provider-cli";
import type { AppEvent, ChatMessage } from "@ai-workbench/shared";
import { EventBus } from "../event-bus.js";
import { createNullLogger } from "../logger.js";
import { ProviderManager } from "../provider-manager.js";
import { SessionManager } from "../session-manager.js";
import { WorkspaceManager } from "../workspace-manager.js";

/**
 * A command line provider driven through the real service graph: registry,
 * session persistence, streaming and provider-native session resume. The CLI is
 * a fixture rather than a vendor tool, so what this proves is the platform —
 * adapter contract, transport, normalization and resume — not any one vendor's
 * flags.
 */

const fixture = join(
  import.meta.dirname,
  "../../../providers/transports/cli/src/__tests__/fixtures/json-cli.mjs",
);

const profile = {
  schemaVersion: 1 as const,
  id: "fixture-cli",
  displayName: "Fixture CLI",
  command: "node",
  auth: { method: "none" as const },
  capabilities: ["chat", "streaming", "sessionResume", "modelSelection"] as const,
  models: [{ id: "fixture-a", displayName: "Fixture A", isDefault: true }],
  args: [],
  modelArgs: ["--model", "{model}"],
  resumeArgs: ["--resume", "{providerSessionId}"],
  promptVia: "stdin" as const,
  output: {
    format: "json-lines" as const,
    rules: [
      { emit: "session" as const, when: { type: "session" }, valueKey: "session_id" },
      { emit: "text_delta" as const, when: { type: "delta" }, valueKey: "text" },
      {
        emit: "usage" as const,
        when: { type: "usage" },
        inputTokensKey: "input_tokens",
        outputTokensKey: "output_tokens",
      },
      { emit: "error" as const, when: { type: "error" }, valueKey: "message" },
    ],
  },
};

interface Harness {
  readonly events: EventBus;
  readonly sessions: SessionManager;
  readonly workspaces: WorkspaceManager;
  readonly database: DatabaseHandle;
  dispose(): Promise<void>;
}

async function boot(directory: string): Promise<Harness> {
  const logger = createNullLogger();
  const database = createDatabase({ file: join(directory, "test.db") });
  await runMigrations(database.client);

  const events = new EventBus();
  const providers = new ProviderManager({
    logger,
    stateDirectory: join(directory, "providers"),
  });

  await providers.register(new CliProviderAdapter(parseProfile(profile)), {
    executablePath: process.execPath,
    arguments: [fixture],
  });

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
    sessions,
    workspaces,
    database,
    dispose: async () => {
      await sessions.shutdown();
      await providers.dispose();
      database.close();
    },
  };
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

describe("command line provider end to end", () => {
  let directory: string;
  let app: Harness;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "ai-workbench-cli-flow-"));
    app = await boot(directory);
  });

  afterEach(async () => {
    await app.dispose();
    await rm(directory, { recursive: true, force: true });
  });

  it("streams an answer and adopts the session id the CLI assigns", async () => {
    const workspace = await app.workspaces.create({ name: "Demo", path: directory });
    const session = await app.sessions.create({
      workspaceId: workspace.id,
      name: "CLI",
      type: "solo",
      providerId: "fixture-cli",
      modelId: "fixture-a",
    });

    // Before the first turn there is no provider-native session yet.
    expect(session.providerSessionId).toBeNull();

    const { messageId } = await app.sessions.sendMessage(session.id, "hello cli");
    const answer = await waitForMessage(app.events, messageId);

    expect(answer.status).toBe("complete");
    expect(answer.content).toContain("hello cli");
    expect(answer.content).toContain("fixture-a");
    expect(answer.usage?.outputTokens).toBe(22);

    const stored = await app.sessions.get(session.id);
    expect(stored?.providerSessionId).toBe("session-abc");
  });

  it("resumes the provider session on the next turn", async () => {
    const workspace = await app.workspaces.create({ name: "Demo", path: directory });
    const session = await app.sessions.create({
      workspaceId: workspace.id,
      name: "CLI",
      type: "solo",
      providerId: "fixture-cli",
    });

    const first = await app.sessions.sendMessage(session.id, "first turn");
    const firstAnswer = await waitForMessage(app.events, first.messageId);
    // Nothing to resume yet, so no resume flag was passed.
    expect(firstAnswer.content).not.toContain("resumed:");

    const second = await app.sessions.sendMessage(session.id, "second turn");
    const secondAnswer = await waitForMessage(app.events, second.messageId);

    // The CLI reports back that it was invoked with the stored session id.
    expect(secondAnswer.content).toContain("resumed:session-abc");
  });

  it("continues the same provider session after a restart", async () => {
    const workspace = await app.workspaces.create({ name: "Demo", path: directory });
    const session = await app.sessions.create({
      workspaceId: workspace.id,
      name: "CLI",
      type: "solo",
      providerId: "fixture-cli",
    });

    const first = await app.sessions.sendMessage(session.id, "before restart");
    await waitForMessage(app.events, first.messageId);

    await app.dispose();
    app = await boot(directory);

    const restored = await app.sessions.get(session.id);
    expect(restored?.providerSessionId).toBe("session-abc");

    const second = await app.sessions.sendMessage(session.id, "after restart");
    const answer = await waitForMessage(app.events, second.messageId);
    expect(answer.content).toContain("resumed:session-abc");
    expect(await app.sessions.listMessages(session.id)).toHaveLength(4);
  });

  it("surfaces a provider failure as a failed turn", async () => {
    const workspace = await app.workspaces.create({ name: "Demo", path: directory });
    const session = await app.sessions.create({
      workspaceId: workspace.id,
      name: "CLI",
      type: "solo",
      providerId: "fixture-cli",
    });

    const { messageId } = await app.sessions.sendMessage(session.id, "make it boom");
    const answer = await waitForMessage(app.events, messageId);

    expect(answer.status).toBe("failed");
    expect(answer.error).toContain("refused");

    // The session survives and the next turn works.
    const next = await app.sessions.sendMessage(session.id, "try again");
    expect((await waitForMessage(app.events, next.messageId)).status).toBe("complete");
  });
});
