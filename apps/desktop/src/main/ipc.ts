import { BrowserWindow, dialog, ipcMain, shell } from "electron";
import { mkdir, readFile, readdir, stat, unlink, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { homedir, userInfo } from "node:os";
import { join } from "node:path";
import { inspectMemoryVault, openMemoryVault } from "@ai-workbench/mcp";
import { discoverAppMcpServers } from "@ai-workbench/provider-cli";
import {
  APP_EVENT_CHANNEL,
  TERMINAL_EVENT_CHANNEL,
  MAX_ATTACHMENT_BYTES,
  exportTeamTemplates,
  ipcContract,
  parseTeamTemplateImport,
  type IpcChannel,
  type IpcHandlerInput,
  type DiscoveredSkill,
  type IpcOutput,
  type Theme,
} from "@ai-workbench/shared";
import {
  describeFinding,
  discoverToolMcpServers,
  importedFrom,
  draftSkill,
  draftTeamTemplate,
  inspectAttachments,
  removeWorkspace,
  toSaveInput,
} from "@ai-workbench/core";
import { importSkillFile, importSkillFolder } from "@ai-workbench/skills";
import { remoteRoot } from "@ai-workbench/workspace-ssh";
import type { WorkspaceFileSystem } from "@ai-workbench/workspace-fs";
import { toProviderConfigOverrides, type AppServices } from "./services.js";
import type { CrashGuard } from "./crash-guard.js";
import type { IslandController } from "./island-controller.js";
import {
  checkForUpdates,
  deferInstall,
  downloadUpdate,
  getUpdateState,
  installUpdate,
  openReleasePage,
  setAutomaticUpdates,
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
  /** Keeps what the interface reports and knows how the last run ended. */
  readonly crashGuard: CrashGuard;
  /** Repaints the app icon when the theme changes. */
  readonly onThemeChanged?: (theme: Theme) => void;
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

  /**
   * A session's folder on this machine, for git to work in. A workspace on
   * another machine has none here: running git on its path would touch a
   * different repository, or nothing.
   */
  const localFolder = async (sessionId: string): Promise<string> => {
    const session = await services.sessions.require(sessionId);
    const workspace = await services.workspaces.require(session.workspaceId);
    if (workspace.connectionId !== null) {
      throw new Error("Source control for a workspace on another machine is not available yet.");
    }
    return session.workingDirectory;
  };

  /** A workspace's folder on this machine; none for a remote workspace. */
  const localWorkspacePath = async (workspaceId: string | undefined): Promise<string | undefined> => {
    const workspace = workspaceId ? await services.workspaces.get(workspaceId) : null;
    return workspace && !workspace.connectionId ? workspace.path : undefined;
  };

  /** Skills the registered tools keep in their own folders, found by their adapters. */
  const discoverToolSkills = async (workspaceId: string | undefined): Promise<DiscoveredSkill[]> => {
    const workspace = workspaceId ? await services.workspaces.get(workspaceId) : null;
    // A workspace on another machine has no folders here to look in.
    const workspacePath = workspace && !workspace.connectionId ? workspace.path : undefined;
    const known = new Set(
      services.skills
        .list()
        .map((skill) => skill.source.path)
        .filter((path): path is string => typeof path === "string"),
    );
    const found = new Map<string, DiscoveredSkill>();
    for (const summary of await services.providers.describeAll()) {
      const adapter = services.providers.get(summary.metadata.id);
      if (!adapter?.discoverImportables || summary.enabled === false) {
        continue;
      }
      const importables = await adapter
        .discoverImportables(workspacePath ? { workspacePath } : {})
        .catch(() => ({ skills: [], mcpServers: [] }));
      for (const skill of importables.skills) {
        // The same folder found through two entries of one tool is listed once.
        if (!found.has(skill.path)) {
          found.set(skill.path, {
            ...skill,
            providerId: summary.metadata.id,
            providerName: summary.metadata.displayName,
            imported: known.has(join(skill.path, "SKILL.md")),
          });
        }
      }
    }
    return [...found.values()];
  };

  let rendererErrorTimes: number[] = [];

  const handlers: Handlers = {
    "app.getInfo": () => ({
      version: options.appVersion,
      platform: process.platform,
      userDataPath: options.userDataPath,
      username: localUsername(),
    }),
    "app.getRecovery": () => {
      const previous = options.crashGuard.previousExit;
      return {
        uncleanExit: previous.unclean,
        previousStartedAt: previous.startedAt,
        reportPath: previous.reportPath,
        recoveredTurns: services.recovered.turns,
        recoveredTeamRuns: services.recovered.teamRuns,
        recoveredTeamTurns: services.recovered.teamTurns,
      };
    },
    "app.reportError": (input) => {
      const now = Date.now();
      // At most a burst per window of time: a view that fails on every frame
      // must not fill the disk or drown the log.
      rendererErrorTimes = rendererErrorTimes.filter((at) => now - at < 60_000);
      if (rendererErrorTimes.length >= 30) {
        return { recorded: false };
      }
      rendererErrorTimes.push(now);
      options.crashGuard.recordRendererError(input);
      return { recorded: true };
    },
    "app.openCrashReports": async () => {
      const directory = options.crashGuard.reportsDirectory;
      if (!directory) {
        return { opened: false };
      }
      await mkdir(directory, { recursive: true });
      return { opened: (await shell.openPath(directory)) === "" };
    },
    "window.getState": () => {
      const window = findMainWindow();
      return { maximized: window?.isMaximized() ?? false, fullscreen: window?.isFullScreen() ?? false };
    },
    "window.minimize": () => { findMainWindow()?.minimize(); },
    "window.toggleMaximize": () => {
      const window = findMainWindow();
      if (window?.isFullScreen()) window.setFullScreen(false);
      else if (window?.isMaximized()) window.unmaximize();
      else window?.maximize();
      return { maximized: window?.isMaximized() ?? false, fullscreen: window?.isFullScreen() ?? false };
    },
    "window.close": () => { findMainWindow()?.close(); },

    "workspace.list": () => services.workspaces.list(),
    "workspace.create": (input) => services.workspaces.create(input),
    "workspace.update": (input) => services.workspaces.update(input),
    "workspace.delete": async (input) => ({
      deleted: await removeWorkspace(services, input.id),
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
    "session.continueOnAccount": (input) => services.sessions.continueOnAccount(input.sessionId),
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
    "session.savePastedImage": async (input) => {
      const extensions = {
        "image/png": "png",
        "image/jpeg": "jpg",
        "image/gif": "gif",
        "image/webp": "webp",
      } as const;
      const extension = extensions[input.mimeType];
      let bytes: Buffer;
      try {
        bytes = Buffer.from(input.dataBase64, "base64");
      } catch {
        throw new Error("The pasted picture could not be read.");
      }
      if (bytes.byteLength === 0 || bytes.byteLength > MAX_ATTACHMENT_BYTES) {
        throw new Error(
          `The pasted picture is larger than ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MB.`,
        );
      }
      // Staged under a generated name in our own folder: the clipboard gives
      // no path, and any name it carries is display-only, never a path.
      const folder = join(options.userDataPath, "pasted-images");
      await mkdir(folder, { recursive: true });
      // Sending copies a picture into the session, so a staged one is only
      // needed while it waits in a draft; old ones are cleared, best effort.
      void clearStalePastedImages(folder);
      const fileName = `pasted-image-${Date.now()}-${randomUUID().slice(0, 8)}.${extension}`;
      const path = join(folder, fileName);
      await writeFile(path, bytes);
      const [inspected] = await inspectAttachments([{ path }]);
      if (!inspected) {
        throw new Error("The pasted picture could not be saved.");
      }
      return inspected;
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
      const summary = await services.providers.describe(input.providerId);
      // Every window learns it, not only the screen that saved it: a path
      // set or cleared changes whether the tool shows in Usage or the menu.
      services.events.publish({ type: "provider.updated", summary });
      return { config, summary };
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

    "git.stage": async (input) => {
      const folder = await localFolder(input.sessionId);
      await services.sourceControl.stage(folder, input.paths);
      return services.git.status(folder);
    },
    "git.unstage": async (input) => {
      const folder = await localFolder(input.sessionId);
      await services.sourceControl.unstage(folder, input.paths);
      return services.git.status(folder);
    },
    "git.commit": async (input) =>
      services.sourceControl.commit(await localFolder(input.sessionId), input.message, input.allowSecrets ?? false),
    "git.suggestMessage": async (input) => {
      const session = await services.sessions.require(input.sessionId);
      if (!session.providerId) {
        throw new Error("Choose a model for this session first.");
      }
      const effort = session.settings["reasoningEffort"];
      return {
        message: await services.sourceControl.suggestMessage(await localFolder(input.sessionId), {
          providerId: session.providerId,
          modelId: session.modelId ?? undefined,
          reasoningEffort: typeof effort === "string" ? effort : undefined,
        }),
      };
    },
    "git.createBranch": async (input) => {
      const folder = await localFolder(input.sessionId);
      await services.sourceControl.createBranch(folder, input.name);
      return services.git.status(folder);
    },
    "git.pull": async (input) => {
      const folder = await localFolder(input.sessionId);
      await services.sourceControl.pull(folder);
      return services.git.status(folder);
    },
    "git.push": async (input) => {
      const folder = await localFolder(input.sessionId);
      await services.sourceControl.push(folder);
      return services.git.status(folder);
    },
    "git.openPullRequest": async (input) =>
      services.sourceControl.openPullRequest(await localFolder(input.sessionId), {
        title: input.title,
        ...(input.body ? { body: input.body } : {}),
        ...(input.base ? { base: input.base } : {}),
      }),

    "teamTemplate.list": () => services.teamTemplates.list(),
    "teamTemplate.save": (input) =>
      services.teamTemplates.save({ ...input.template, ...(input.id ? { id: input.id } : {}) }),
    "teamTemplate.delete": async (input) => ({ deleted: await services.teamTemplates.delete(input.id) }),
    "teamTemplate.draft": (input) =>
      draftTeamTemplate(services.providers, input, join(options.userDataPath, "team-template-drafts")),
    "teamTemplate.export": async (input) => {
      const all = await services.teamTemplates.list();
      const chosen = input.ids ? all.filter((template) => input.ids?.includes(template.id)) : all;
      if (chosen.length === 0) {
        return { saved: false, count: 0 };
      }
      const window = findMainWindow();
      const dialogOptions = {
        title: "Export team templates",
        defaultPath: "team-templates.json",
        filters: [{ name: "JSON", extensions: ["json"] }],
      };
      const target = await (window ? dialog.showSaveDialog(window, dialogOptions) : dialog.showSaveDialog(dialogOptions));
      if (target.canceled || !target.filePath) {
        return { saved: false, count: 0 };
      }
      await writeFile(target.filePath, exportTeamTemplates(chosen), "utf8");
      return { saved: true, count: chosen.length };
    },
    "teamTemplate.import": async () => {
      const window = findMainWindow();
      const dialogOptions = {
        title: "Import team templates",
        properties: ["openFile"] as "openFile"[],
        filters: [{ name: "JSON", extensions: ["json"] }],
      };
      const picked = await (window ? dialog.showOpenDialog(window, dialogOptions) : dialog.showOpenDialog(dialogOptions));
      const file = picked.filePaths[0];
      if (picked.canceled || !file) {
        return { imported: 0, errors: [] };
      }
      const { size } = await stat(file);
      if (size > 2 * 1024 * 1024) {
        return { imported: 0, errors: ["The file is larger than a template file can be."] };
      }
      const { templates, errors } = parseTeamTemplateImport(await readFile(file, "utf8"));
      for (const template of templates) {
        await services.teamTemplates.save(template);
      }
      return { imported: templates.length, errors };
    },

    "github.status": () => services.github.status(),
    "github.signInWithToken": (input) => services.github.signInWithToken(input.token),
    "github.startDeviceFlow": async () => {
      const status = await services.github.startDeviceFlow();
      const page = status.pending?.verificationUri;
      // Only GitHub's own https page is ever opened from here.
      if (page && /^https:\/\//.test(page)) {
        void shell.openExternal(page).catch(() => undefined);
      }
      return status;
    },
    "github.signOut": () => services.github.signOut(),

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
    "skill.discover": (input) => discoverToolSkills(input.workspaceId),
    "skill.importDiscovered": async (input) => {
      // Only folders the tools themselves name can be imported this way.
      const offered = new Set((await discoverToolSkills(input.workspaceId)).map((entry) => entry.path));
      const imported = [];
      const failed: Array<{ path: string; reason: string }> = [];
      for (const path of input.paths) {
        if (!offered.has(path)) {
          failed.push({ path, reason: "It is not one of the skills your tools keep." });
          continue;
        }
        try {
          const saved = await services.skills.save(await importSkillFolder(path));
          // Skills reach sessions on demand — a line each until one is loaded —
          // so a skill the person brings over is available everywhere at once.
          await services.skills.assign({ skillId: saved.id, scope: "global", enabled: true });
          imported.push(saved);
        } catch (error) {
          failed.push({ path, reason: error instanceof Error ? error.message : String(error) });
        }
      }
      return { imported, failed };
    },
    "skill.importFiles": async () => {
      const window = findMainWindow();
      const options = {
        title: "Import skills",
        filters: [{ name: "Markdown", extensions: ["md", "markdown"] }],
        properties: ["openFile", "multiSelections"] as ("openFile" | "multiSelections")[],
      };
      const result = await (window ? dialog.showOpenDialog(window, options) : dialog.showOpenDialog(options));
      if (result.canceled || result.filePaths.length === 0) {
        return { cancelled: true, imported: [], failed: [] };
      }
      const imported = [];
      const failed: Array<{ path: string; reason: string }> = [];
      for (const file of result.filePaths) {
        try {
          imported.push(await services.skills.save(await importSkillFile(file)));
        } catch (error) {
          failed.push({ path: file, reason: error instanceof Error ? error.message : String(error) });
        }
      }
      return { cancelled: false, imported, failed };
    },
    "skill.draft": (input) =>
      draftSkill(services.providers, input, join(options.userDataPath, "skill-drafts")),
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
    "mcp.discover": async (input) => {
      const path = await localWorkspacePath(input.workspaceId);
      const [findings, existing] = await Promise.all([
        discoverToolMcpServers(services.providers, path, await discoverAppMcpServers(path ? { workspacePath: path } : {})),
        services.mcp.list(),
      ]);
      return findings.map((finding) => describeFinding(finding, existing));
    },
    "mcp.importDiscovered": async (input) => {
      // Only servers the tools themselves name can be imported this way.
      const path = await localWorkspacePath(input.workspaceId);
      const findings = await discoverToolMcpServers(
        services.providers,
        path,
        await discoverAppMcpServers(path ? { workspacePath: path } : {}),
      );
      const byKey = new Map(findings.map((finding) => [finding.key, finding]));
      const existing = await services.mcp.list();
      const taken = new Set(existing.map((config) => config.id));
      const imported = [];
      const failed: Array<{ key: string; reason: string }> = [];
      const notes: Array<{ key: string; note: string }> = [];
      for (const key of input.keys) {
        const finding = byKey.get(key);
        if (!finding) {
          failed.push({ key, reason: "It is not one of the servers your tools have." });
          continue;
        }
        try {
          // Imported before: updated in place, keeping its id.
          const before = importedFrom(finding, existing);
          const converted = toSaveInput(finding, taken, {
            ...(before ? { existingId: before.id } : {}),
            ...(input.scope === "workspace" && input.workspaceId ? { workspaceId: input.workspaceId } : {}),
          });
          // Secrets go into secure storage in the main process; the window
          // never had them and never gets them.
          const saved = await services.mcp.saveFromWindow(
            {
              ...converted.input,
              ...(Object.keys(converted.secrets).length > 0 ? { newSecretEnv: converted.secrets } : {}),
            },
            { origin: converted.origin },
          );
          taken.add(saved.id);
          imported.push(saved);
          notes.push(...converted.notes.map((note) => ({ key, note })));
        } catch (error) {
          failed.push({ key, reason: error instanceof Error ? error.message : String(error) });
        }
      }
      return { imported, failed, notes };
    },
      "mcp.save": async (input) => {
        if (input.id === "obsidian-memory") {
          throw new Error("Change the shared vault from the Obsidian page.");
        }
        const saved = await services.mcp.saveFromWindow(input);
        return saved;
      },
    "mcp.chooseMemoryVault": async () => {
      const window = findMainWindow();
      const result = await (window
        ? dialog.showOpenDialog(window, { title: "Choose an Obsidian Markdown vault", properties: ["openDirectory"] })
        : dialog.showOpenDialog({ title: "Choose an Obsidian Markdown vault", properties: ["openDirectory"] }));
      const chosen = result.canceled ? null : result.filePaths[0];
      if (!chosen) return null;
      const root = await openMemoryVault(chosen);
      // Electron runs this bundled MCP server in Node mode. Every provider
      // reaches the same folder through the existing connector bridge.
        const saved = await services.mcp.saveFromWindow({
        id: "obsidian-memory",
        name: "Obsidian memory",
        transport: "stdio",
        command: process.execPath,
        args: [join(__dirname, "memory-server.js"), root],
        env: { ELECTRON_RUN_AS_NODE: "1" },
        cwd: root,
        enabled: true,
        availability: "everywhere",
        workspaceIds: [],
        });
        await services.antigravityMemory.reconcile(saved);
        return saved;
      },
      "memory.inspect": async () => {
        const server = await services.mcp.get("obsidian-memory");
        if (!server?.enabled || !server.cwd) return null;
        const [vault, antigravity] = await Promise.all([
          inspectMemoryVault(server.cwd),
          services.antigravityMemory.status(server),
        ]);
        return { vault, antigravity };
      },
    "mcp.signIn": (input) => services.mcp.signIn(input.id, input.clientSecret),
    "mcp.signOut": (input) => services.mcp.signOut(input.id),
      "mcp.delete": async (input) => {
        const deleted = await services.mcp.delete(input.id);
        if (deleted && input.id === "obsidian-memory") {
          await services.antigravityMemory.reconcile(null);
        }
        return { deleted };
      },
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
    "team.sendMessage": (input) => services.teams.sendNote(input.runId, input.content, input.attachments ?? []),
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
    "team.startRun": (input) =>
      services.teams.startRun({
        teamId: input.teamId,
        goal: input.goal,
        ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
        ...(input.sessionId ? { sessionId: input.sessionId } : {}),
        ...(input.attachments ? { attachments: input.attachments } : {}),
      }),
    "team.resumeRun": (input) => services.teams.resumeRun(input.runId),
    "team.continueRun": (input) =>
      services.teams.continueRun({
        runId: input.runId,
        goal: input.goal,
        ...(input.sessionId ? { sessionId: input.sessionId } : {}),
        ...(input.attachments ? { attachments: input.attachments } : {}),
      }),
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
    "settings.update": async (input) => {
      const settings = await services.settings.update(input);
      if (input.theme !== undefined || input.mode !== undefined) {
        island.setAppearance({ theme: settings.theme, mode: settings.mode });
      }
      if (input.theme !== undefined) {
        options.onThemeChanged?.(settings.theme);
      }
      if (input.autoUpdate !== undefined) {
        await setAutomaticUpdates(settings.autoUpdate);
      }
      return settings;
    },

    "update.check": () => checkForUpdates(),
    "update.download": () => downloadUpdate(),
    "update.install": () => installUpdate(),
    "update.defer": () => deferInstall(),
    "update.getStatus": () => getUpdateState(),
    "update.openReleasePage": () => openReleasePage(),
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

/** How long a pasted picture waits in a draft before its staged copy goes. */
const PASTED_IMAGE_KEEP_MS = 7 * 24 * 60 * 60 * 1000;

async function clearStalePastedImages(folder: string): Promise<void> {
  try {
    const now = Date.now();
    for (const name of await readdir(folder)) {
      if (!name.startsWith("pasted-image-")) {
        continue;
      }
      const path = join(folder, name);
      const info = await stat(path).catch(() => null);
      if (info?.isFile() && now - info.mtimeMs > PASTED_IMAGE_KEEP_MS) {
        await unlink(path).catch(() => undefined);
      }
    }
  } catch {
    // Nothing to clear, or not now: the next paste tries again.
  }
}
