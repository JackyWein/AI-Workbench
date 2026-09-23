import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeTempDirectory, removeTempDirectory } from "@ai-workbench/test-support";
import { createDatabase, runMigrations, type DatabaseHandle } from "@ai-workbench/database";
import {
  CliProviderAdapter,
  claudeCodeProfile,
  parseProfile,
} from "@ai-workbench/provider-cli";
import type { AppEvent, ChatMessage } from "@ai-workbench/shared";
import { EventBus } from "../event-bus.js";
import { createNullLogger } from "../logger.js";
import { ProviderManager } from "../provider-manager.js";
import { SessionManager } from "../session-manager.js";
import { UsageService } from "../usage-service.js";
import { WorkspaceManager } from "../workspace-manager.js";

/**
 * Drives a real, installed provider CLI through the whole application stack.
 *
 * This is skipped by default because it spends real provider quota, which the
 * regular test suite must never do (spec §113). Run it deliberately, when the
 * tool is installed and signed in:
 *
 *   AI_WORKBENCH_REAL_PROVIDER=1 bun run test
 *
 * The prompts are kept as small as possible.
 */
const enabled = process.env["AI_WORKBENCH_REAL_PROVIDER"] === "1";

interface Harness {
  readonly events: EventBus;
  readonly sessions: SessionManager;
  readonly workspaces: WorkspaceManager;
  readonly usage: UsageService;
  readonly providers: ProviderManager;
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
  await providers.register(new CliProviderAdapter(parseProfile(claudeCodeProfile)));

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
    providers,
    usage: new UsageService({ providers, events, logger }),
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

describe.skipIf(!enabled)("installed provider CLI, end to end", () => {
  let directory: string;
  let app: Harness;

  beforeEach(async () => {
    directory = await makeTempDirectory("ai-workbench-real-");
    app = await boot(directory);
  });

  afterEach(async () => {
    await app.dispose();
    await removeTempDirectory(directory);
  });

  it("detects the installed tool", async () => {
    const [summary] = await app.providers.describeAll();
    expect(summary?.installation.state).toBe("installed");
    expect(summary?.installation.version).toBeTruthy();
  });

  it("answers, reports usage and resumes the same conversation", async () => {
    const workspace = await app.workspaces.create({ name: "Real", path: directory });
    const session = await app.sessions.create({
      workspaceId: workspace.id,
      name: "Real provider",
      type: "solo",
      providerId: "claude-code",
      // The cheapest model, since this spends real quota.
      modelId: "claude-haiku-4-5",
    });

    const first = await app.sessions.sendMessage(
      session.id,
      "Reply with exactly: alpha",
    );
    const answer = await waitForMessage(app.events, first.messageId);

    expect(answer.status).toBe("complete");
    expect(answer.content.toLowerCase()).toContain("alpha");

    // The tool's own session id was adopted, so the next turn can resume it.
    const stored = await app.sessions.get(session.id);
    expect(stored?.providerSessionId).toBeTruthy();
    expect(stored?.providerSessionId).not.toContain("pending:");

    // Usage came from the provider itself and is not invented.
    const usage = await app.usage.get();
    const snapshot = usage.snapshots.find((entry) => entry.providerId === "claude-code");
    expect(snapshot?.state).toBe("available");
    expect(snapshot?.source).toBe("cli");
    expect((snapshot?.limits.length ?? 0)).toBeGreaterThan(0);

    const second = await app.sessions.sendMessage(
      session.id,
      "What word did you just reply with? Answer with the word only.",
    );
    const continued = await waitForMessage(app.events, second.messageId);

    expect(continued.status).toBe("complete");
    // Knowing the earlier answer proves the provider session was resumed.
    expect(continued.content.toLowerCase()).toContain("alpha");
  }, 180_000);
});
