import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { app, BrowserWindow } from "electron";
import { createServices, type AppServices } from "./services.js";
import { checkForUpdates, initUpdater } from "./updater.js";
import { registerIpcHandlers, removeIpcHandlers } from "./ipc.js";
import { IslandController } from "./island-controller.js";
import { runStartupCheck } from "./startup-check.js";
import { resolveIslandFile } from "./status-island.js";
import { hideToTray } from "./tray.js";
import { createMainWindow, resolveRendererFile } from "./window.js";

const isDevelopment = !app.isPackaged;

/** Set by `pnpm verify:app`, which starts the app headlessly and exits. */
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
  services = await createServices({ userDataPath, isDevelopment });

  // Update checks run against GitHub Releases in packaged builds only. The
  // startup check only ever asks which version is current; downloading and
  // installing each wait for an explicit user action in Settings.
  initUpdater({
    logger: services.logger.child("UPDATER"),
    publish: (event) => services?.events.publish(event),
    currentVersion: app.getVersion(),
  });

  const preloadFile = join(__dirname, "../preload/index.js");
  const window = createMainWindow({
    devServerUrl: process.env["ELECTRON_RENDERER_URL"],
    rendererFile: resolveRendererFile(__dirname),
    preloadFile,
  });
  mainWindow = window;

  // The island and the tray keep the runtime reachable with no window on
  // screen (spec §104), so they exist as soon as the services do.
  island = new IslandController({
    services,
    islandFile: resolveIslandFile(__dirname),
    preloadFile,
    devServerUrl: process.env["ELECTRON_RENDERER_URL"],
    focusMainWindow: () => {
      const existing = mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
      if (existing) {
        if (existing.isMinimized()) {
          existing.restore();
        }
        existing.show();
        existing.focus();
        island?.setMainVisible(true);
      }
      return existing;
    },
    quit: () => {
      quitting = true;
      app.quit();
    },
  });

  registerIpcHandlers({
    services,
    appVersion: app.getVersion(),
    userDataPath,
    island,
  });

  // Closing the main window may leave the runtime going (spec §104).
  attachMainWindowCloseBehavior(window);

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
  }

  if (startupCheckOnly) {
    const workspaceDirectory =
      process.env["AI_WORKBENCH_CHECK_WORKSPACE"] ??
      (await mkdtemp(join(tmpdir(), "ai-workbench-check-workspace-")));
    const result = await runStartupCheck(window, services.logger, {
      workspaceDirectory,
      mode: process.env["AI_WORKBENCH_CHECK_MODE"] === "resume" ? "resume" : "create",
      island,
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
    const preferences = services?.attention.preferences;
    if (preferences?.closeToTray) {
      event.preventDefault();
      hideToTray(window);
      island?.setMainVisible(false);
    }
  });
}

app.on("second-instance", () => {
  // Only the main window is brought forward: the first window in the list may
  // be the island, which must never steal focus from a second launch.
  const existing = mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
  if (existing) {
    if (existing.isMinimized()) {
      existing.restore();
    }
    existing.show();
    existing.focus();
  }
});

// The startup check runs headlessly against its own user-data directory, so it
// takes no lock: contending for one would make it quit silently — and exit 0 —
// while another instance happens to be running, which reads as a pass.
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
  if (BrowserWindow.getAllWindows().length === 0 && services) {
    mainWindow = createMainWindow({
      devServerUrl: process.env["ELECTRON_RENDERER_URL"],
      rendererFile: resolveRendererFile(__dirname),
      preloadFile: join(__dirname, "../preload/index.js"),
    });
    attachMainWindowCloseBehavior(mainWindow);
    island?.setMainVisible(true);
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
