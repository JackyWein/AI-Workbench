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
import type {
  Logger,
  ProviderConfig,
  StoredProviderConfig,
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
    dispose: async () => {
      await sessions.shutdown();
      await providers.dispose();
      events.clear();
      database.close();
    },
  };
}
