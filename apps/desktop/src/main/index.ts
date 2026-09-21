import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { app, BrowserWindow } from "electron";
import { createServices, type AppServices } from "./services.js";
import { registerIpcHandlers, removeIpcHandlers } from "./ipc.js";
import { runStartupCheck } from "./startup-check.js";
import { createMainWindow, resolveRendererFile } from "./window.js";

const isDevelopment = !app.isPackaged;

/** Set by `pnpm verify:app`, which starts the app headlessly and exits. */
const startupCheckOnly = process.env["AI_WORKBENCH_STARTUP_CHECK"] === "1";

let services: AppServices | null = null;
let shuttingDown = false;

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

  registerIpcHandlers({
    services,
    appVersion: app.getVersion(),
    userDataPath,
  });

  const window = createMainWindow({
    devServerUrl: process.env["ELECTRON_RENDERER_URL"],
    rendererFile: resolveRendererFile(__dirname),
    preloadFile: join(__dirname, "../preload/index.js"),
  });

  if (startupCheckOnly) {
    const workspaceDirectory =
      process.env["AI_WORKBENCH_CHECK_WORKSPACE"] ??
      (await mkdtemp(join(tmpdir(), "ai-workbench-check-workspace-")));
    const result = await runStartupCheck(window, services.logger, {
      workspaceDirectory,
      mode: process.env["AI_WORKBENCH_CHECK_MODE"] === "resume" ? "resume" : "create",
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
  removeIpcHandlers();
  await services?.dispose();
  services = null;
}

app.on("second-instance", () => {
  const [existing] = BrowserWindow.getAllWindows();
  if (existing) {
    if (existing.isMinimized()) {
      existing.restore();
    }
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
  // The tray and background runtime arrive with G6; until then closing the last
  // window ends the app on every platform except macOS.
  if (process.platform !== "darwin") {
    void shutdown().then(() => app.quit());
  }
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0 && services) {
    createMainWindow({
      devServerUrl: process.env["ELECTRON_RENDERER_URL"],
      rendererFile: resolveRendererFile(__dirname),
      preloadFile: join(__dirname, "../preload/index.js"),
    });
  }
});

app.on("before-quit", () => {
  void shutdown();
});
