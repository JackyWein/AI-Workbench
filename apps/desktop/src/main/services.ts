import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import {
  AgentTerminalService,
  EventBus,
  McpService,
  PluginService,
  ProviderAccountService,
  ProviderConfigService,
  ProviderManager,
  SessionManager,
  SettingsService,
  SkillService,
  TeamManager,
  SqlCredentialStorage,
  UsageService,
  WorkspaceManager,
  createLogger,
} from "@ai-workbench/core";
import { CredentialManager } from "@ai-workbench/credentials";
import { McpManager } from "@ai-workbench/mcp";
import { ClaudeSkillImporter, MarkdownSkillImporter } from "@ai-workbench/skills";
import { createDatabase, runMigrations, type DatabaseHandle } from "@ai-workbench/database";
import {
  CliProviderAdapter,
  builtInCliProfiles,
  parseProfile,
} from "@ai-workbench/provider-cli";
import { MockProviderAdapter } from "@ai-workbench/provider-mock";
import { resolveInteractiveCommand } from "@ai-workbench/transport-cli";
import { TerminalManager } from "@ai-workbench/terminal";
import { StatusAttentionService } from "@ai-workbench/status";
import { SafeStorageEncryption } from "./safe-storage.js";
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
  readonly accounts: ProviderAccountService;
  readonly workspaces: WorkspaceManager;
  readonly sessions: SessionManager;
  readonly usage: UsageService;
  readonly settings: SettingsService;
  readonly skills: SkillService;
  readonly plugins: PluginService;
  readonly mcp: McpService;
  readonly teams: TeamManager;
  readonly attention: StatusAttentionService;
  readonly credentials: CredentialManager;
  /** Importers offered when the user adds skills from a folder (spec §31). */
  readonly skillImporters: readonly (ClaudeSkillImporter | MarkdownSkillImporter)[];
  readonly files: WorkspaceFileSystem;
  readonly git: GitService;
  readonly terminals: TerminalManager;
  /** Providers' own interactive interfaces running in terminals. */
  readonly agentTerminals: AgentTerminalService;
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

  // Late-bound: usage is created after the providers it aggregates.
  let usageRef: UsageService | null = null;
  const providers = new ProviderManager({
    logger,
    stateDirectory: join(options.userDataPath, "providers"),
    onProviderChanged: (summary) => {
      events.publish({ type: "provider.updated", summary });
      // New limits read in the background reach the usage popover too.
      if (usageRef && summary.usage) {
        usageRef.invalidate();
        void usageRef.refresh();
      }
    },
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

  // Further accounts of tools that keep several side by side (spec §39).
  const accounts = new ProviderAccountService({
    db: database.db,
    events,
    logger,
    providers,
    accountsDirectory: join(options.userDataPath, "accounts"),
    configFor: overridesFor,
  });
  await accounts.restore();

  const workspaces = new WorkspaceManager({ db: database.db, events, logger });

  const credentials = new CredentialManager({
    encryption: new SafeStorageEncryption(),
    storage: new SqlCredentialStorage(database.db),
    logger,
  });
  logger.child("PLUGIN").info("Secret storage", {
    available: credentials.isAvailable(),
    backend: credentials.describeBackend(),
  });

  const skills = new SkillService({ db: database.db, logger });
  await skills.load();

  const plugins = new PluginService({ db: database.db, logger, credentials });
  await plugins.load();

  const mcpManager = new McpManager({ logger, clientVersion: "1.0.0" });
  const mcp = new McpService({ db: database.db, logger, manager: mcpManager });
  // Servers the user enabled come up with the application; one that refuses to
  // start is reported, never thrown (spec §60).
  const connected = await mcp.connectEnabled();
  if (connected.length > 0) {
    logger.child("MCP").info("Configured servers", {
      total: connected.length,
      connected: connected.filter((status) => status.state === "connected").length,
    });
  }

  const teams = new TeamManager({ db: database.db, events, logger, providers });

  const settings = new SettingsService({ db: database.db, logger });
  const storedSettings = await settings.get();
  const attention = new StatusAttentionService({
    logger,
    preferences: storedSettings.statusIsland,
  });

  const sessions = new SessionManager({
    db: database.db,
    events,
    logger,
    providers,
    workspaces,
    skills,
    mcp,
  });
  const usage = new UsageService({ providers, events, logger });
  usageRef = usage;

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

  // Late-bound: agent terminals are created after the terminals they run in.
  let agentTerminalsRef: AgentTerminalService | null = null;
  const terminals = new TerminalManager({
    logger,
    onData: (terminalId, chunk) => emitTerminal({ type: "data", terminalId, chunk }),
    onExit: (terminalId, exitCode) => {
      emitTerminal({ type: "exit", terminalId, exitCode });
      agentTerminalsRef?.handleExit(terminalId, exitCode);
    },
  });

  const agentTerminals = new AgentTerminalService({
    db: database.db,
    events,
    logger,
    providers,
    workspaces,
    terminals,
    resolveCommand: (launch) => resolveInteractiveCommand(launch),
  });
  agentTerminalsRef = agentTerminals;

  // A deleted workspace must not leave its agents running.
  events.on("workspace.deleted", (event) => {
    if (event.type === "workspace.deleted") {
      agentTerminals.stopAll(event.workspaceId);
    }
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
    accounts,
    workspaces,
    sessions,
    usage,
    settings,
    skills,
    plugins,
    mcp,
    teams,
    attention,
    credentials,
    skillImporters: [new ClaudeSkillImporter(), new MarkdownSkillImporter()],
    files,
    git,
    terminals,
    agentTerminals,
    onTerminalEvent: (listener) => {
      terminalListeners.add(listener);
      return () => terminalListeners.delete(listener);
    },
    dispose: async () => {
      agentTerminals.stopAll();
      terminals.closeAll();
      terminalListeners.clear();
      // A run in flight is paused rather than orphaned (spec §132).
      await teams.shutdown();
      await sessions.shutdown();
      await mcpManager.disconnectAll();
      await providers.dispose();
      events.clear();
      database.close();
    },
  };
}
