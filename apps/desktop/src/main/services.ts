import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import {
  EventBus,
  ProviderConfigService,
  ProviderManager,
  SessionManager,
  SettingsService,
  UsageService,
  WorkspaceManager,
  createLogger,
} from "@ai-workbench/core";
import { createDatabase, runMigrations, type DatabaseHandle } from "@ai-workbench/database";
import {
  CliProviderAdapter,
  builtInCliProfiles,
  parseProfile,
} from "@ai-workbench/provider-cli";
import { MockProviderAdapter } from "@ai-workbench/provider-mock";
import { TerminalManager } from "@ai-workbench/terminal";
import { WorkspaceFileSystem } from "@ai-workbench/workspace-fs";
import { GitService } from "@ai-workbench/workspace-git";
import type {
  Logger,
  ProviderConfig,
  StoredProviderConfig,
  TerminalEvent,
} from "@ai-workbench/shared";

export interface AppServices {
  readonly logger: Logger;
  readonly events: EventBus;
  readonly database: DatabaseHandle;
  readonly providers: ProviderManager;
  readonly providerConfigs: ProviderConfigService;
  readonly workspaces: WorkspaceManager;
  readonly sessions: SessionManager;
  readonly usage: UsageService;
  readonly settings: SettingsService;
  readonly files: WorkspaceFileSystem;
  readonly git: GitService;
  readonly terminals: TerminalManager;
  /** Subscribes to terminal output; returns an unsubscribe function. */
  onTerminalEvent(listener: (event: TerminalEvent) => void): () => void;
  dispose(): Promise<void>;
}

export interface CreateServicesOptions {
  readonly userDataPath: string;
  readonly isDevelopment: boolean;
}

/** Maps stored user overrides onto the adapter configuration shape. */
export function toProviderConfigOverrides(
  stored: StoredProviderConfig | undefined,
): Partial<ProviderConfig> {
  if (!stored) {
    return {};
  }
  return {
    ...(stored.executablePath === null ? {} : { executablePath: stored.executablePath }),
    ...(stored.arguments.length === 0 ? {} : { arguments: stored.arguments }),
    ...(stored.defaultModel === null ? {} : { defaultModel: stored.defaultModel }),
    settings: stored.settings,
  };
}

/**
 * Wires the main-process services. Everything the renderer can reach goes
 * through these objects; the renderer itself never touches the database, the
 * filesystem or a provider process (spec §5).
 */
export async function createServices(
  options: CreateServicesOptions,
): Promise<AppServices> {
  await mkdir(options.userDataPath, { recursive: true });

  const logger = createLogger({
    level: options.isDevelopment ? "debug" : "info",
    destinationFile: join(options.userDataPath, "ai-workbench.log"),
  });

  const database = createDatabase({
    file: join(options.userDataPath, "ai-workbench.db"),
  });
  const migration = await runMigrations(database.client, logger.child("DATABASE"));
  logger.child("DATABASE").info("Database ready", {
    applied: migration.applied.length,
    skipped: migration.skipped.length,
  });

  const events = new EventBus();

  const providers = new ProviderManager({
    logger,
    stateDirectory: join(options.userDataPath, "providers"),
  });

  const providerConfigs = new ProviderConfigService({ db: database.db, logger });
  const storedConfigs = new Map(
    (await providerConfigs.list()).map((config) => [config.providerId, config]),
  );
  const overridesFor = (providerId: string): Partial<ProviderConfig> =>
    toProviderConfigOverrides(storedConfigs.get(providerId));

  await providers.register(new MockProviderAdapter(), overridesFor("mock"));

  // CLI-backed providers are data: adding one is a profile, not a code change.
  for (const profile of builtInCliProfiles) {
    const adapter = new CliProviderAdapter(parseProfile(profile));
    await providers.register(adapter, overridesFor(adapter.metadata.id));
  }

  const workspaces = new WorkspaceManager({ db: database.db, events, logger });
  const sessions = new SessionManager({
    db: database.db,
    events,
    logger,
    providers,
    workspaces,
  });
  const usage = new UsageService({ providers, events, logger });
  const settings = new SettingsService({ db: database.db, logger });

  const files = new WorkspaceFileSystem({ logger });
  const git = new GitService({ logger });

  // Terminal output is pushed rather than polled, so listeners register here
  // and the IPC layer forwards to whichever windows exist.
  const terminalListeners = new Set<(event: TerminalEvent) => void>();
  const emitTerminal = (event: TerminalEvent): void => {
    for (const listener of terminalListeners) {
      try {
        listener(event);
      } catch {
        // One broken listener must not stop the others.
      }
    }
  };

  const terminals = new TerminalManager({
    logger,
    onData: (terminalId, chunk) => emitTerminal({ type: "data", terminalId, chunk }),
    onExit: (terminalId, exitCode) =>
      emitTerminal({ type: "exit", terminalId, exitCode }),
  });

  // A deleted session must not leave shells running.
  events.on("session.deleted", (event) => {
    if (event.type === "session.deleted") {
      terminals.closeAll(event.sessionId);
    }
  });

  return {
    logger,
    events,
    database,
    providers,
    providerConfigs,
    workspaces,
    sessions,
    usage,
    settings,
    files,
    git,
    terminals,
    onTerminalEvent: (listener) => {
      terminalListeners.add(listener);
      return () => terminalListeners.delete(listener);
    },
    dispose: async () => {
      terminals.closeAll();
      terminalListeners.clear();
      await sessions.shutdown();
      await providers.dispose();
      events.clear();
      database.close();
    },
  };
}
