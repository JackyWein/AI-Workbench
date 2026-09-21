import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import {
  EventBus,
  ProviderManager,
  SessionManager,
  SettingsService,
  UsageService,
  WorkspaceManager,
  createLogger,
} from "@ai-workbench/core";
import { createDatabase, runMigrations, type DatabaseHandle } from "@ai-workbench/database";
import { MockProviderAdapter } from "@ai-workbench/provider-mock";
import type { Logger } from "@ai-workbench/shared";

export interface AppServices {
  readonly logger: Logger;
  readonly events: EventBus;
  readonly database: DatabaseHandle;
  readonly providers: ProviderManager;
  readonly workspaces: WorkspaceManager;
  readonly sessions: SessionManager;
  readonly usage: UsageService;
  readonly settings: SettingsService;
  dispose(): Promise<void>;
}

export interface CreateServicesOptions {
  readonly userDataPath: string;
  readonly isDevelopment: boolean;
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
  await providers.register(new MockProviderAdapter());

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

  return {
    logger,
    events,
    database,
    providers,
    workspaces,
    sessions,
    usage,
    settings,
    dispose: async () => {
      await sessions.shutdown();
      await providers.dispose();
      events.clear();
      database.close();
    },
  };
}
