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

type Handler<C extends IpcChannel> = (
  input: IpcInput<C>,
) => Promise<IpcOutput<C>> | IpcOutput<C>;

type Handlers = { [C in IpcChannel]: Handler<C> };

export interface RegisterIpcOptions {
  readonly services: AppServices;
  readonly appVersion: string;
  readonly userDataPath: string;
}

/**
 * Registers one validated handler per contract channel (spec §105). Input is
 * parsed with the channel's schema before any service is touched, and errors
 * are converted into a plain message so no stack or internal path leaks to the
 * renderer.
 */
export function registerIpcHandlers(options: RegisterIpcOptions): void {
  const { services } = options;
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
    "provider.getUsage": () => services.usage.get(),
    "provider.refreshUsage": () => services.usage.refresh(),

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
