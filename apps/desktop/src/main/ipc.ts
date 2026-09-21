import { BrowserWindow, dialog, ipcMain } from "electron";
import {
  APP_EVENT_CHANNEL,
  TERMINAL_EVENT_CHANNEL,
  ipcContract,
  type IpcChannel,
  type IpcInput,
  type IpcOutput,
} from "@ai-workbench/shared";
import { toProviderConfigOverrides, type AppServices } from "./services.js";
import type { IslandController } from "./island-controller.js";

type Handler<C extends IpcChannel> = (
  input: IpcInput<C>,
) => Promise<IpcOutput<C>> | IpcOutput<C>;

type Handlers = { [C in IpcChannel]: Handler<C> };

export interface RegisterIpcOptions {
  readonly services: AppServices;
  readonly appVersion: string;
  readonly userDataPath: string;
  readonly island: IslandController;
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

  const handlers: Handlers = {
    "app.getInfo": () => ({
      version: options.appVersion,
      platform: process.platform,
      userDataPath: options.userDataPath,
    }),

    "workspace.list": () => services.workspaces.list(),
    "workspace.create": (input) => services.workspaces.create(input),
    "workspace.update": (input) => services.workspaces.update(input),
    "workspace.delete": async (input) => ({
      deleted: await services.workspaces.delete(input.id),
    }),
    "workspace.chooseDirectory": async () => {
      const window = BrowserWindow.getFocusedWindow();
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
      services.sessions.sendMessage(input.sessionId, input.text),
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

    "files.list": async (input) => {
      const session = await services.sessions.require(input.sessionId);
      return services.files.list(session.workingDirectory, input.path);
    },
    "files.read": async (input) => {
      const session = await services.sessions.require(input.sessionId);
      return services.files.readText(session.workingDirectory, input.path);
    },

    "git.status": async (input) => {
      const session = await services.sessions.require(input.sessionId);
      return services.git.status(session.workingDirectory);
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

    "skill.list": () => services.skills.list(),
    "skill.save": (input) => services.skills.save(input),
    "skill.delete": async (input) => ({
      deleted: await services.skills.delete(input.id),
    }),
    "skill.importFromDirectory": async () => {
      const window = BrowserWindow.getFocusedWindow();
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

    "settings.get": () => services.settings.get(),
    "settings.update": (input) => services.settings.update(input),
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
        return await handler(parsed.data as IpcInput<typeof channel>);
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Unexpected error";
        logger.error("IPC handler failed", { channel, error: message });
        throw new Error(message);
      }
    });
  }

  const broadcast = (channel: string, payload: unknown): void => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) {
        window.webContents.send(channel, payload);
      }
    }
  };

  // One push channel carries every domain event to whichever windows exist.
  services.events.subscribe((event) => broadcast(APP_EVENT_CHANNEL, event));

  // Terminal bytes go on their own channel, so a busy shell cannot drown the
  // domain events the rest of the application depends on.
  services.onTerminalEvent((event) => broadcast(TERMINAL_EVENT_CHANNEL, event));
}

export function removeIpcHandlers(): void {
  for (const channel of Object.keys(ipcContract) as IpcChannel[]) {
    ipcMain.removeHandler(channel);
  }
}
