import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { prepareKey } from "@ai-workbench/workspace-ssh";
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
  ConnectionService,
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
  antigravityProfile,
  cliProviderFactory,
  parseProfile,
  scrubHostEnvironment,
} from "@ai-workbench/provider-cli";
import { claudeCode, claudeCodeFactory } from "@ai-workbench/provider-claude";
import { codexFactory } from "@ai-workbench/provider-codex";
import { geminiFactory } from "@ai-workbench/provider-gemini";
import { opencodeFactory } from "@ai-workbench/provider-opencode";
import { registerCustomProviders } from "@ai-workbench/provider-openai-compatible";
import { MockProviderAdapter } from "@ai-workbench/provider-mock";
import { resolveInteractiveCommand } from "@ai-workbench/transport-cli";
import { TerminalManager } from "@ai-workbench/terminal";
import { StatusAttentionService } from "@ai-workbench/status";
import { SafeStorageEncryption } from "./safe-storage.js";
import { CheckEncryption } from "./check-storage.js";
import { LocalWorkspaceFileSystem, type WorkspaceFileSystem } from "@ai-workbench/workspace-fs";
import { GitService } from "@ai-workbench/workspace-git";
import { WorkspaceAccess } from "./workspace-access.js";
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
  /** The machines a workspace can live on (spec §25). */
  readonly connections: ConnectionService;
  /** Decides how a workspace's files are reached, here or over SSH. */
  readonly access: WorkspaceAccess;
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
  try {
    return await createServicesInner(options, logger, database);
  } catch (error) {
    // Startup never leaves a half-wired runtime behind: the process exits on
    // bootstrap failure, but the database must still be closed so no lock or
    // journal survives the failed start.
    try {
      database.close();
    } catch {
      // Closing is best-effort; the original error is what matters.
    }
    throw error;
  }
}

async function createServicesInner(
  options: CreateServicesOptions,
  logger: Logger,
  database: DatabaseHandle,
): Promise<AppServices> {
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
        void usageRef.refresh().catch((error: unknown) => {
          logger.debug("Usage refresh after provider change failed", {
            error: error instanceof Error ? error.message : String(error),
          });
        });
      }
    },
  });

  const providerConfigs = new ProviderConfigService({ db: database.db, logger });
  // Read once: the same snapshot feeds the per-provider overrides below and
  // the custom-provider registration, so the two cannot disagree.
  const storedProviderConfigs = await providerConfigs.list();
  const storedConfigs = new Map(
    storedProviderConfigs.map((config) => [config.providerId, config]),
  );
  const overridesFor = (providerId: string): Partial<ProviderConfig> =>
    toProviderConfigOverrides(storedConfigs.get(providerId));

  await providers.register(new MockProviderAdapter(), overridesFor("mock"));

  // CLI-backed providers are profile data plus, where a tool needs code, the
  // extensions of its own package. Each family registers its default entry
  // now and further accounts through the account service below.
  const scrubbed = scrubHostEnvironment([claudeCode]);
  if (scrubbed.length > 0) {
    logger.child("PROVIDER").info("Started from inside a tool session; its markers were removed", {
      variables: scrubbed,
    });
  }
  const cliFactories = [
    claudeCodeFactory(),
    codexFactory(),
    cliProviderFactory(parseProfile(antigravityProfile)),
    geminiFactory(),
    opencodeFactory(),
  ];
  for (const factory of cliFactories) {
    await providers.registerFactory(factory, overridesFor(factory.family));
  }

  // Custom OpenAI-compatible endpoints from stored configs (spec §16, §17):
  // no core change is needed to support a new one.
  registerCustomProviders(providers.registry, storedProviderConfigs);

  // Hidden providers stay registered (existing sessions keep working) but
  // offer nothing new: pickers filter them, and no new session defaults to
  // one.
  for (const config of storedProviderConfigs) {
    if (!config.enabled) {
      providers.setProviderEnabled(config.providerId, false);
    }
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

  // The operating system's own secret storage, always, except in the headless
  // verification run on a machine that has none — where the alternative is not
  // a weaker store but no coverage at all (see CheckEncryption).
  const safeStorage = new SafeStorageEncryption();
  const encryption =
    safeStorage.isAvailable() || process.env["AI_WORKBENCH_STARTUP_CHECK"] !== "1"
      ? safeStorage
      : new CheckEncryption(options.userDataPath);
  const credentials = new CredentialManager({
    encryption,
    storage: new SqlCredentialStorage(database.db),
    logger,
  });
  logger.child("PLUGIN").info("Secret storage", {
    available: credentials.isAvailable(),
    backend: credentials.describeBackend(),
  });

  // A workspace root is either on this computer or on a machine reached over
  // SSH. These three know about that; nothing above them does.
  const connections = new ConnectionService({
    db: database.db,
    events,
    logger,
    credentials,
  });
  const files = new LocalWorkspaceFileSystem({ logger });
  const access = new WorkspaceAccess({ logger, connections, local: files });
  // The service and the access layer need each other, so the link is made
  // once both exist rather than passed through a constructor.
  connections.useProbe({
    homeDirectory: (connectionId) => access.homeDirectory(connectionId),
    disconnect: (connectionId) => access.disconnect(connectionId),
    checkKey: (text, passphrase) => prepareKey(text, passphrase),
  });

  const workspaces = new WorkspaceManager({
    db: database.db,
    events,
    logger,
    // A root on another machine is checked on that machine.
    checkRemoteDirectory: (connectionId, path) =>
      access.verifyRemoteDirectory(connectionId, path),
  });

  const skills = new SkillService({ db: database.db, logger });
  await skills.load();

  const plugins = new PluginService({ db: database.db, logger, credentials });
  await plugins.load();

  const mcpManager = new McpManager({ logger, clientVersion: "1.0.0" });
  const mcp = new McpService({
    db: database.db,
    logger,
    manager: mcpManager,
    credentials: { resolve: (reference) => credentials.resolve(reference) },
  });
  // Servers the user enabled come up with the application; one that refuses to
  // start is reported, never thrown (spec §60).
  const connected = await mcp.connectEnabled();
  if (connected.length > 0) {
    logger.child("MCP").info("Configured servers", {
      total: connected.length,
      connected: connected.filter((status) => status.state === "connected").length,
    });
  }

  const teams = new TeamManager({ db: database.db, events, logger, providers, mcp });

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
    attachmentsDirectory: join(options.userDataPath, "attachments"),
  });
  await sessions.recoverInterrupted();
  const usage = new UsageService({ providers, events, logger });
  usageRef = usage;

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
    connections,
    access,
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
      // Order matters: agents and shells stop first, then the managers that
      // own in-flight work pause it, then connections close. The database
      // closes last, and always — even when a step above throws.
      try {
        agentTerminals.stopAll();
        terminals.closeAll();
        terminalListeners.clear();
        // A run in flight is paused rather than orphaned (spec §132).
        await teams.shutdown();
        await sessions.shutdown();
        await mcpManager.disconnectAll();
        // Open SSH connections are closed with everything else, so a quit
        // does not leave a socket to a remote machine behind.
        access.dispose();
        await providers.dispose();
        events.clear();
      } finally {
        database.close();
      }
    },
  };
}
