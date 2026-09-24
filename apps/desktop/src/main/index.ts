import { readFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { app, BrowserWindow, net, shell } from "electron";
import { createServices, type AppServices } from "./services.js";
import { BUILD_COMMIT, SIGNED_MAC } from "./build-info.js";
import {
  checkForUpdates,
  deferInstall,
  getUpdateState,
  initUpdater,
  installUpdate,
  simulateDownloadForCheck,
} from "./updater.js";
import { registerIpcHandlers, removeIpcHandlers } from "./ipc.js";
import { IslandController } from "./island-controller.js";
import { approveSignInPage, runStartupCheck } from "./startup-check.js";
import { resolveIslandFile } from "./status-island.js";
import { hideToTray } from "./tray.js";
import { createMainWindow, resolveRendererFile } from "./window.js";

/**
 * The application's own version. Packaged, Electron reads it from the app's
 * package.json; started from out/ during development it reports its own
 * version instead (44.x), which Settings, the sidebar and the update check
 * then took for the application's.
 */
function appVersion(): string {
  if (app.isPackaged) {
    return app.getVersion();
  }
  try {
    const manifest = JSON.parse(readFileSync(join(__dirname, "../../package.json"), "utf8")) as {
      version?: unknown;
    };
    return typeof manifest.version === "string" ? manifest.version : app.getVersion();
  } catch {
    return app.getVersion();
  }
}

const isDevelopment = !app.isPackaged;

/** How often a running app asks whether a newer version was released. */
const UPDATE_CHECK_INTERVAL_MS = 60 * 60 * 1000;

/** Set by `bun run verify:app`, which starts the app headlessly and exits. */
const startupCheckOnly = process.env["AI_WORKBENCH_STARTUP_CHECK"] === "1";

let services: AppServices | null = null;
let island: IslandController | null = null;
let mainWindow: BrowserWindow | null = null;
let shuttingDown = false;
/** Set once the user really means to leave, so closing to tray can be undone. */
let quitting = false;

async function bootstrap(): Promise<void> {
  if (startupCheckOnly) {
    // The check must never touch the user's real database. A caller may pin the
    // directory so a second run verifies what the first one persisted.
    app.setPath(
      "userData",
      process.env["AI_WORKBENCH_CHECK_DATA_DIR"] ??
        (await mkdtemp(join(tmpdir(), "ai-workbench-check-"))),
    );
  }

  const userDataPath = app.getPath("userData");
  services = await createServices({
    userDataPath,
    isDevelopment,
    // The check has no person at a browser: its sign-in pages approve at
    // once, so it opens them itself and follows the redirect back.
    openExternal: startupCheckOnly
      ? (url) => approveSignInPage(url)
      : (url) => (/^https?:\/\//i.test(url) ? shell.openExternal(url) : undefined),
    // Electron's own networking, so connectors go through the system proxy
    // and certificate store like the rest of the app.
    fetch: (input, init) => net.fetch(input instanceof URL ? input.toString() : input, init),
  });

  // Antigravity reads MCP servers from its own global configuration. Keep the
  // Workbench-owned memory entry in step after app updates change its path.
  // Headless verification never changes the host's agent configuration.
  if (!startupCheckOnly) {
    void services.mcp.get("obsidian-memory")
      .then((server) => services?.antigravityMemory.reconcile(server) ?? null)
      .then((status) => {
        if (status && status.state === "error") {
          services?.logger.warn("Antigravity memory registration failed");
        }
      })
      .catch(() => services?.logger.warn("Antigravity memory registration failed"));
  }

  // Update checks run against GitHub Releases in packaged builds only. A
  // release counts as new by its version or, for the same version, by the
  // commit it was built from. With automatic updates on (the default) a new
  // one downloads in the background and installs when the app quits; off,
  // downloading and installing each wait for the person. The startup check
  // only ever asks which version is current.
  const storedSettings = await services.settings.get();
  initUpdater({
    logger: services.logger.child("UPDATER"),
    publish: (event) => services?.events.publish(event),
    currentVersion: appVersion(),
    currentCommit: BUILD_COMMIT,
    automatic: storedSettings.autoUpdate && !startupCheckOnly,
    signedMac: SIGNED_MAC,
  });

  const preloadFile = join(__dirname, "../preload/index.js");
  const window = openAppWindow();

  // The island and the tray keep the runtime reachable with no window on
  // screen (spec §104), so they exist as soon as the services do.
  island = new IslandController({
    services,
    islandFile: resolveIslandFile(__dirname),
    preloadFile,
    devServerUrl: process.env["ELECTRON_RENDERER_URL"],
    focusMainWindow: () => revealMainWindow(),
    // Pure read for visibility/focus checks: focusing here would un-minimize
    // the window on every background tick that asks whether it is visible.
    getMainWindow: () => {
      return mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
    },
    quit: () => {
      quitting = true;
      app.quit();
    },
    updates: {
      state: getUpdateState,
      install: installUpdate,
      defer: deferInstall,
    },
  });

  registerIpcHandlers({
    services,
    appVersion: appVersion(),
    userDataPath,
    island,
  });

  // The island starts in check mode too: `verify:app` proves the companion
  // window, the tray and the attention service in the running application,
  // not just in unit tests.
  try {
    await island.start();
  } catch (error) {
    // A half-started island (tray created, timer running) must not leak when
    // startup fails: shut down what was wired so far, then surface the error.
    await shutdown().catch(() => undefined);
    throw error;
  }

  if (!startupCheckOnly) {
    // Fire and forget on purpose: the updater never rejects, reports through
    // the update.* domain events, and the current state stays readable
    // through update.getStatus.
    void checkForUpdates();
    // Hourly, in the background: people leave the app open for days, and a
    // new version should reach them without a restart.
    setInterval(() => {
      const status = getUpdateState().status;
      if (status !== "downloading" && status !== "downloaded") {
        void checkForUpdates();
      }
    }, UPDATE_CHECK_INTERVAL_MS).unref();
  }

  if (startupCheckOnly) {
    const workspaceDirectory =
      process.env["AI_WORKBENCH_CHECK_WORKSPACE"] ??
      (await mkdtemp(join(tmpdir(), "ai-workbench-check-workspace-")));
    const result = await runStartupCheck(window, services.logger, {
      workspaceDirectory,
      mode: process.env["AI_WORKBENCH_CHECK_MODE"] === "resume" ? "resume" : "create",
      island,
      simulateDownload: simulateDownloadForCheck,
    });
    await shutdown();
    app.exit(result.healthy ? 0 : 1);
  }
}

async function shutdown(): Promise<void> {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  try {
    removeIpcHandlers();
    island?.dispose();
    island = null;
  } finally {
    // Services must always be disposed, even when IPC removal or the island
    // cleanup above throws — otherwise the database stays locked.
    try {
      await services?.dispose();
    } finally {
      services = null;
    }
  }
}

/** Creates the main window with its close and focus behaviour attached. */
function openAppWindow(): BrowserWindow {
  const window = createMainWindow({
    devServerUrl: process.env["ELECTRON_RENDERER_URL"],
    rendererFile: resolveRendererFile(__dirname),
    preloadFile: join(__dirname, "../preload/index.js"),
  });
  mainWindow = window;
  // Closing the main window may leave the runtime going (spec §104).
  attachMainWindowCloseBehavior(window);
  attachMainWindowFocusTracking(window);
  return window;
}

/**
 * Brings the main window forward from the tray, the island or a second
 * launch: restored when minimized, shown when hidden to the tray, and made
 * anew when it was closed while the runtime kept going.
 */
function revealMainWindow(): BrowserWindow | null {
  if (!services || shuttingDown) {
    return null;
  }
  const window = mainWindow && !mainWindow.isDestroyed() ? mainWindow : openAppWindow();
  if (window.isMinimized()) {
    window.restore();
  }
  window.show();
  window.focus();
  island?.setMainVisible(true);
  return window;
}

/**
 * The island hides while the main window is focused and returns when focus
 * leaves it. Kept as a function so windows created later — for example on
 * macOS activate — behave the same as the first one.
 */
function attachMainWindowFocusTracking(window: BrowserWindow): void {
  window.on("focus", () => island?.setMainFocused(true));
  window.on("blur", () => island?.setMainFocused(false));
}

/**
 * Closing the main window may leave the runtime going (spec §104). Kept as a
 * function so windows created later — for example on macOS activate — behave
 * the same as the first one.
 */
function attachMainWindowCloseBehavior(window: BrowserWindow): void {
  window.on("close", (event) => {
    if (quitting || startupCheckOnly) {
      return;
    }
    event.preventDefault();
    if (services?.attention.preferences.closeToTray) {
      hideToTray(window);
      island?.setMainVisible(false);
      return;
    }
    // Without the tray, the main window is the app: closing it quits, even
    // though the island's own window is still open and would otherwise keep
    // a windowless runtime alive that nothing can bring back.
    quitting = true;
    app.quit();
  });
}

app.on("second-instance", () => {
  // Only the main window is brought forward: the first window in the list may
  // be the island, which must never steal focus from a second launch.
  revealMainWindow();
});

// The startup check runs headlessly against its own user-data directory, so it
// takes no lock: contending for one would make it quit silently — and exit 0 —
// while another instance happens to be running, which reads as a pass.
// Development previews choose their own profile before acquiring the lock.
// Otherwise a running installed copy makes the preview quit before bootstrap
// reaches its profile override.
if (!startupCheckOnly && isDevelopment && process.env["AI_WORKBENCH_DATA_DIR"]) {
  app.setPath("userData", process.env["AI_WORKBENCH_DATA_DIR"]);
}
if (!startupCheckOnly && !app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.whenReady().then(bootstrap).catch((error: unknown) => {
    // Startup failures must be visible rather than leaving a silent blank app.
    console.error("AI Workbench failed to start", error);
    app.exit(1);
  });
}

app.on("window-all-closed", () => {
  // With close-to-tray on, the runtime outlives the window and the tray keeps
  // it reachable (spec §104). Otherwise the last window ends the application,
  // as on every platform except macOS.
  if (process.platform === "darwin" || services?.attention.preferences.closeToTray) {
    return;
  }
  void shutdown()
    .then(() => app.quit())
    .catch(() => app.exit(1));
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    revealMainWindow();
  }
});

app.on("before-quit", (event) => {
  if (shuttingDown) {
    return;
  }
  // Graceful shutdown must finish before the process ends (G7): services are
  // disposed first, and the re-entrant quit after that proceeds.
  event.preventDefault();
  quitting = true;
  void shutdown()
    .then(() => app.quit())
    .catch(() => app.exit(1));
});
