import { BrowserWindow, dialog, ipcMain } from "electron";
import { homedir, userInfo } from "node:os";
import { join } from "node:path";
import {
  APP_EVENT_CHANNEL,
  TERMINAL_EVENT_CHANNEL,
  ipcContract,
  type IpcChannel,
  type IpcHandlerInput,
  type IpcOutput,
} from "@ai-workbench/shared";
import { inspectAttachments } from "@ai-workbench/core";
import { remoteRoot } from "@ai-workbench/workspace-ssh";
import type { WorkspaceFileSystem } from "@ai-workbench/workspace-fs";
import { toProviderConfigOverrides, type AppServices } from "./services.js";
import type { IslandController } from "./island-controller.js";
import {
  checkForUpdates,
  downloadUpdate,
  getUpdateState,
  installUpdate,
} from "./updater.js";

type Handler<C extends IpcChannel> = (
  input: IpcHandlerInput<C>,
) => Promise<IpcOutput<C>> | IpcOutput<C>;

type Handlers = { [C in IpcChannel]: Handler<C> };

export interface RegisterIpcOptions {
  readonly services: AppServices;
  readonly appVersion: string;
  readonly userDataPath: string;
  readonly island: IslandController;
}

/** Subscriptions that push main-process events to the renderer. */
const eventUnsubscribes: Array<() => void> = [];

/** The island has its own tiny bridge; pushes go to the main window only. */
/** OS account name for the sidebar card; never throws, never a secret. */
function localUsername(): string {
  try {
    const name = userInfo().username.trim();
    return name.length > 0 ? name : "local";
  } catch {
    return "local";
  }
}

function isIslandWindow(window: BrowserWindow): boolean {  try {
    return window.webContents.getURL().endsWith("island/index.html");
  } catch {
    return false;
  }
}

function findMainWindow(): BrowserWindow | null {
  return (
    BrowserWindow.getAllWindows().find(
      (window) => !window.isDestroyed() && !isIslandWindow(window),
    ) ?? null
  );
}

/**
 * Strips absolute paths from messages handed to the renderer. The full detail
 * is logged next to the channel in the main process; the UI gets a message
 * without machine-specific paths.
 */
function sanitizeErrorMessage(message: string): string {
  const withoutWindows = message.replace(
    /[A-Za-z]:\\(?:[^\\s"'`,;()]*\\)*[^\\s"'`,;()]*/g,
    "[path]",
  );
  const withoutPosix = withoutWindows.replace(
    /(^|[\s"'`(])(?:\/[^/\s"'`()]+)+\/?/g,
    "$1[path]",
  );
  const cleaned = withoutPosix.trim();
  return cleaned.length === 0 ? "Unexpected error" : cleaned;
}

/** The services report scope decisions as maps; the contract carries lists. */
function toAssignments<K extends string>(
  key: K,
  decisions: Record<string, boolean>,
): Array<Record<K, string> & { enabled: boolean }> {
  return Object.entries(decisions).map(
    ([id, enabled]) => ({ [key]: id, enabled }) as Record<K, string> & { enabled: boolean },
  );
}

/**
 * Registers one validated handler per contract channel (spec §105). Input is
 * parsed with the channel's schema before any service is touched, and errors
 * are converted into a plain message so no stack or internal path leaks to the
 * renderer.
 */
export function registerIpcHandlers(options: RegisterIpcOptions): void {
  const { services, island } = options;
  const logger = services.logger.child("IPC");

  /**
   * Where a session's files are, and how to reach them. A session works inside
   * its workspace, so the workspace decides which machine that is.
   */
  const rootFor = async (
    sessionId: string,
  ): Promise<{ files: WorkspaceFileSystem; root: string }> => {
    const session = await services.sessions.require(sessionId);
    const workspace = await services.workspaces.require(session.workspaceId);
    return {
      files: services.access.fileSystemFor(workspace),
      root: services.access.rootForSession(workspace, session.workingDirectory),
    };
  };

  const handlers: Handlers = {
    "app.getInfo": () => ({
      version: options.appVersion,
      platform: process.platform,
      userDataPath: options.userDataPath,
      username: localUsername(),
    }),

    "workspace.list": () => services.workspaces.list(),
    "workspace.create": (input) => services.workspaces.create(input),
    "workspace.update": (input) => services.workspaces.update(input),
    "workspace.delete": async (input) => ({
      deleted: await services.workspaces.delete(input.id),
    }),
    "workspace.chooseDirectory": async () => {
      // Dialogs belong to the main window: the focused window may be the
      // island, which must never become a dialog parent.
      const window = findMainWindow();
      const result = await (window
        ? dialog.showOpenDialog(window, { properties: ["openDirectory", "createDirectory"] })
        : dialog.showOpenDialog({ properties: ["openDirectory", "createDirectory"] }));
      return { path: result.canceled ? null : (result.filePaths[0] ?? null) };
    },

    "session.list": (input) => services.sessions.list(input.workspaceId),
    "session.create": (input) => services.sessions.create(input),
    "session.update": (input) => services.sessions.update(input),
    "session.delete": async (input) => ({
      deleted: await services.sessions.delete(input.id),
    }),
    "session.sendMessage": (input) =>
      services.sessions.sendMessage(input.sessionId, input.text, input.attachments ?? []),
    "session.chooseAttachments": async () => {
      const window = findMainWindow();
      const options = { properties: ["openFile", "multiSelections"] as ("openFile" | "multiSelections")[] };
      const result = await (window
        ? dialog.showOpenDialog(window, options)
        : dialog.showOpenDialog(options));
      if (result.canceled) {
        return [];
      }
      // Described from the disk; the session checks them again when sent.
      return inspectAttachments(result.filePaths.map((path) => ({ path })));
    },
    "session.cancel": async (input) => ({
      cancelled: await services.sessions.cancel(input.sessionId),
    }),
    "session.getStatus": (input) => ({
      busy: services.sessions.isBusy(input.sessionId),
    }),

    "message.list": (input) =>
      services.sessions.listMessages(input.sessionId, input.limit),

    "provider.list": () => services.providers.describeAll(),
    "provider.refresh": () => services.providers.describeAll(),
    "provider.getConfigs": () => services.providerConfigs.list(),
    "provider.saveConfig": async (input) => {
      const config = await services.providerConfigs.save(input);
      // Apply it immediately so the user can test a corrected path without
      // restarting the application.
      await services.providers.reconfigure(
        input.providerId,
        toProviderConfigOverrides(config),
      );
      services.providers.setProviderEnabled(input.providerId, config.enabled);
      return {
        config,
        summary: await services.providers.describe(input.providerId),
      };
    },
    "provider.rescanModels": async (input) => {
      const adapter = services.providers.get(input.providerId);
      if (!adapter) {
        throw new Error(`Provider "${input.providerId}" is not registered`);
      }
      await adapter.refreshModels?.();
      return services.providers.describe(input.providerId);
    },
    "provider.getUsage": () => services.usage.get(),
    "provider.refreshUsage": () => services.usage.refresh(),

    "account.list": () => services.accounts.list(),
    "account.detect": () => services.accounts.detect(),
    "account.add": (input) => services.accounts.add(input),
    "account.remove": async (input) => ({
      removed: await services.accounts.remove(input.id),
    }),

    "connection.list": () => services.connections.list(),
    "connection.create": (input) => services.connections.create(input),
    "connection.update": (input) => services.connections.update(input),
    "connection.chooseKeyFile": async () => {
      const window = findMainWindow();
      // Keys live in ~/.ssh on every system that has OpenSSH, Windows too.
      const options = {
        title: "Choose a private key",
        defaultPath: join(homedir(), ".ssh"),
        properties: ["openFile", "showHiddenFiles"] as ("openFile" | "showHiddenFiles")[],
      };
      const result = await (window
        ? dialog.showOpenDialog(window, options)
        : dialog.showOpenDialog(options));
      return { path: result.canceled ? null : (result.filePaths[0] ?? null) };
    },
    "connection.delete": async (input) => ({
      deleted: await services.connections.delete(input.id),
    }),
    "connection.test": (input) => services.connections.test(input.id),
    "connection.browse": async (input) => {
      // Browsing starts at the account's home directory, which is where a
      // person looking for a project on a server starts too.
      const base =
        input.path === "" ? await services.access.homeDirectory(input.id) : input.path;
      const root = remoteRoot(input.id, base);
      const files = services.access.remoteFileSystem();
      return { path: base, entries: await files.list(root) };
    },

    // The file browser and the editor do not know, and must not know, whether
    // a workspace lives on this computer or on another machine (spec §25).
    "files.list": async (input) => {
      const { files, root } = await rootFor(input.sessionId);
      return files.list(root, input.path);
    },
    "files.read": async (input) => {
      const { files, root } = await rootFor(input.sessionId);
      return files.readText(root, input.path);
    },
    "files.write": async (input) => {
      const { files, root } = await rootFor(input.sessionId);
      return files.writeText(root, input.path, input.content);
    },

    "git.status": async (input) => {
      const session = await services.sessions.require(input.sessionId);
      const workspace = await services.workspaces.require(session.workspaceId);
      if (workspace.connectionId !== null) {
        // Running git here against a path that only exists on another machine
        // would report someone else's repository, or nonsense. Saying there is
        // none is the honest answer until git speaks over the connection.
        return {
          isRepository: false,
          branch: null,
          detached: false,
          upstream: null,
          ahead: 0,
          behind: 0,
          changes: [],
          clean: true,
        };
      }
      return services.git.status(session.workingDirectory);
    },
    "git.diff": async (input) => {
      const session = await services.sessions.require(input.sessionId);
      const workspace = await services.workspaces.require(session.workspaceId);
      if (workspace.connectionId !== null) {
        return { path: input.path, diff: "" };
      }
      const diff = await services.git.diff(session.workingDirectory, input.path, input.staged);
      return { path: input.path, diff };
    },

    "terminal.list": (input) => services.terminals.list(input.sessionId),
    "terminal.create": async (input) => {
      const session = await services.sessions.require(input.sessionId);
      return services.terminals.create({
        sessionId: session.id,
        // The working directory is the session's, already inside its workspace.
        cwd: session.workingDirectory,
        ...(input.cols === undefined ? {} : { cols: input.cols }),
        ...(input.rows === undefined ? {} : { rows: input.rows }),
      });
    },
    "terminal.attach": async (input) => {
      const session = await services.sessions.require(input.sessionId);
      return services.terminals.attach({
        sessionId: session.id,
        cwd: session.workingDirectory,
        ...(input.cols === undefined ? {} : { cols: input.cols }),
        ...(input.rows === undefined ? {} : { rows: input.rows }),
      });
    },
    "terminal.write": (input) => {
      services.terminals.write(input.terminalId, input.data);
      return { written: true };
    },
    "terminal.resize": (input) => {
      services.terminals.resize(input.terminalId, input.cols, input.rows);
      return { resized: true };
    },
    "terminal.close": (input) => ({
      closed: services.terminals.close(input.terminalId),
    }),

    "terminal.reattach": (input) => ({
      exists: services.terminals.has(input.terminalId),
      scrollback: services.terminals.scrollback(input.terminalId),
    }),

    "agentTerminal.list": (input) => services.agentTerminals.list(input.workspaceId),
    "agentTerminal.launch": (input) => services.agentTerminals.launch(input),
    "agentTerminal.start": (input) =>
      services.agentTerminals.start(input.id, {
        ...(input.cols === undefined ? {} : { cols: input.cols }),
        ...(input.rows === undefined ? {} : { rows: input.rows }),
      }),
    "agentTerminal.stop": (input) => services.agentTerminals.stop(input.id),
    "agentTerminal.remove": async (input) => ({
      removed: await services.agentTerminals.remove(input.id),
    }),
    "agentTerminal.update": (input) => services.agentTerminals.update(input),
    "agentTerminal.login": (input) => services.agentTerminals.startLogin(input),
    "agentTerminal.setup": (input) => services.agentTerminals.startSetup(input),

    "skill.list": () => services.skills.list(),
    "skill.save": (input) => services.skills.save(input),
    "skill.delete": async (input) => ({
      deleted: await services.skills.delete(input.id),
    }),
    "skill.importFromDirectory": async () => {
      const window = findMainWindow();
      const properties = ["openDirectory"] as const;
      const result = await (window
        ? dialog.showOpenDialog(window, { properties: [...properties] })
        : dialog.showOpenDialog({ properties: [...properties] }));
      const directory = result.canceled ? null : result.filePaths[0];
      if (!directory) {
        return { cancelled: true, imported: [], failed: [] };
      }

      // Every importer that recognizes the folder contributes; a format that
      // fails is reported by name rather than failing the whole import.
      const failed: Array<{ path: string; reason: string }> = [];
      const inputs = [];
      for (const importer of services.skillImporters) {
        try {
          if (await importer.canImport(directory)) {
            inputs.push(...(await importer.import(directory)));
          }
        } catch (error) {
          failed.push({
            path: `${directory} (${importer.displayName})`,
            reason: error instanceof Error ? error.message : String(error),
          });
        }
      }

      const imported = [];
      for (const skill of inputs) {
        try {
          imported.push(await services.skills.save(skill));
        } catch (error) {
          failed.push({
            path: String(skill.id ?? "unnamed skill"),
            reason: error instanceof Error ? error.message : String(error),
          });
        }
      }
      return { cancelled: false, imported, failed };
    },
    "skill.assign": async (input) => {
      await services.skills.assign(input);
      return { assigned: true };
    },
    "skill.assignments": async (input) => {
      const decisions = await services.skills.assignmentsFor(input);
      return {
        global: toAssignments("skillId", decisions.global),
        workspace: toAssignments("skillId", decisions.workspace),
        session: toAssignments("skillId", decisions.session),
      };
    },
    "skill.effectiveForSession": async (input) => {
      const session = await services.sessions.require(input.sessionId);
      // Without a provider, or with one that cannot say, the list is unfiltered
      // rather than silently empty.
      const adapter = session.providerId
        ? services.providers.get(session.providerId)
        : undefined;
      const capabilities = await adapter?.getCapabilities().catch(() => undefined);
      return services.skills.resolveForSession({
        sessionId: session.id,
        workspaceId: session.workspaceId,
        ...(capabilities ? { capabilities } : {}),
      });
    },

    "plugin.list": () => services.plugins.list(),
    "plugin.save": (input) => services.plugins.save(input),
    "plugin.assign": async (input) => {
      await services.plugins.assign(input);
      return { assigned: true };
    },
    "plugin.assignments": async (input) => {
      const decisions = await services.plugins.assignmentsFor(input);
      return {
        global: toAssignments("pluginId", decisions.global),
        session: toAssignments("pluginId", decisions.session),
      };
    },
    "plugin.resolveForSession": async (input) => {
      const session = await services.sessions.require(input.sessionId);
      return services.plugins.resolveForSession({
        sessionId: session.id,
        workspaceId: session.workspaceId,
      });
    },
    "plugin.accounts": () => services.plugins.accounts(),
    "plugin.connectAccount": (input) => services.plugins.connectAccount(input),
    "plugin.disconnectAccount": async (input) => ({
      disconnected: await services.plugins.disconnectAccount(input.id),
    }),

    "mcp.list": () => services.mcp.list(),
    "mcp.save": (input) => services.mcp.save(input),
    "mcp.delete": async (input) => ({
      deleted: await services.mcp.delete(input.id),
    }),
    "mcp.statuses": () => services.mcp.statuses(),
    "mcp.connect": (input) => services.mcp.connect(input.id),
    "mcp.disconnect": async (input) => ({
      disconnected: await services.mcp.disconnect(input.id),
    }),
    "mcp.sessionAccess": async (input) => ({
      serverIds: await services.mcp.enabledForSession(input.sessionId),
    }),
    "mcp.setSessionAccess": async (input) => {
      await services.mcp.setSessionAccess(input.sessionId, input.serverId, input.enabled);
      return { updated: true };
    },

    "team.list": (input) => services.teams.list(input.workspaceId),
    "team.create": async (input) => {
      // An agent inherits the workspace directory unless it names its own, so
      // a team cannot be pointed outside the workspace by accident.
      const workspace = await services.workspaces.require(input.workspaceId);
      return services.teams.create({ ...input, workingDirectory: workspace.path });
    },
    "team.setLead": (input) => services.teams.setLeadAgent(input.teamId, input.agentId),
    "team.update": (input) => services.teams.update(input),
    "team.sendMessage": (input) => services.teams.sendNote(input.runId, input.content),
    "team.setWorkingDirectory": (input) =>
      services.teams.setWorkingDirectory(
        input.teamId,
        input.workingDirectory,
        input.allowOutsideWorkspace,
      ),
    "team.delete": async (input) => ({
      deleted: await services.teams.delete(input.teamId),
    }),

    "team.listRuns": (input) => services.teams.listRuns(input.teamId),
    "team.getRun": (input) => services.teams.getSnapshot(input.runId),
    "team.startRun": (input) => services.teams.startRun(input),
    "team.resumeRun": (input) => services.teams.resumeRun(input.runId),
    "team.pauseRun": (input) => services.teams.pauseRun(input.runId),
    "team.cancelRun": (input) => services.teams.cancelRun(input.runId),

    "statusIsland.getState": () => island.refresh(),
    "statusIsland.setPreferences": (input) => island.setPreferences(input),
    "statusIsland.show": () => ({ visible: island.show() }),
    "statusIsland.hide": () => ({ visible: island.hide() }),
    "statusIsland.pinWidget": (input) => island.pin(input.widget),
    "statusIsland.cycle": (input) => island.cycle(input.direction),
    "statusIsland.open": (input) => ({ opened: island.open(input) }),
    "statusIsland.dismiss": () => island.dismiss(),
    "statusIsland.ask": (input) => island.ask(input.key, input.text),
    "statusIsland.respond": (input) => island.respond(input.key, input.option),
    "statusIsland.resetPosition": () => island.resetPosition(),
    "statusIsland.resize": (input) => ({ visible: island.resize(input.width, input.height) }),
    "statusIsland.dragStart": (input) => island.beginDrag(input.grabX, input.grabY),
    "statusIsland.dragEnd": () => island.endDrag(),

    "settings.get": () => services.settings.get(),
    "settings.update": (input) => services.settings.update(input),

    "update.check": () => checkForUpdates(),
    "update.download": () => downloadUpdate(),
    "update.install": () => installUpdate(),
    "update.getStatus": () => getUpdateState(),
  };

  for (const channel of Object.keys(handlers) as IpcChannel[]) {
    ipcMain.handle(channel, async (_event, rawInput: unknown) => {
      const definition = ipcContract[channel];
      const parsed = definition.input.safeParse(rawInput);
      if (!parsed.success) {
        logger.warn("Rejected IPC payload", {
          channel,
          issue: parsed.error.issues[0]?.message,
        });
        throw new Error(`Invalid payload for ${channel}`);
      }

      try {
        const handler = handlers[channel] as Handler<typeof channel>;
        return await handler(parsed.data as IpcHandlerInput<typeof channel>);
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Unexpected error";
        // Full detail stays in the main-process log; the renderer gets the
        // same message without absolute paths.
        logger.error("IPC handler failed", { channel, error: message });
        throw new Error(sanitizeErrorMessage(message));
      }
    });
  }

  const broadcast = (channel: string, payload: unknown): void => {
    // The island has its own push path (island state); domain and terminal
    // events go to the main window only.
    for (const window of BrowserWindow.getAllWindows()) {
      if (window.isDestroyed() || isIslandWindow(window)) {
        continue;
      }
      try {
        window.webContents.send(channel, payload);
      } catch (error) {
        logger.warn("Broadcast to the main window failed", {
          channel,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  };

  // One push channel carries every domain event to whichever windows exist.
  eventUnsubscribes.push(services.events.subscribe((event) => broadcast(APP_EVENT_CHANNEL, event)));

  // Terminal bytes go on their own channel, so a busy shell cannot drown the
  // domain events the rest of the application depends on.
  eventUnsubscribes.push(services.onTerminalEvent((event) => broadcast(TERMINAL_EVENT_CHANNEL, event)));
}

export function removeIpcHandlers(): void {
  while (eventUnsubscribes.length > 0) {
    const unsubscribe = eventUnsubscribes.pop();
    try {
      unsubscribe?.();
    } catch {
      // Unsubscribing must never break shutdown.
    }
  }
  for (const channel of Object.keys(ipcContract) as IpcChannel[]) {
    ipcMain.removeHandler(channel);
  }
}
