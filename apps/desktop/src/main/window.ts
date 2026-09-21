import { join } from "node:path";
import { BrowserWindow, shell } from "electron";

export interface CreateMainWindowOptions {
  readonly devServerUrl?: string | undefined;
  readonly rendererFile: string;
  readonly preloadFile: string;
}

export function createMainWindow(options: CreateMainWindowOptions): BrowserWindow {
  const window = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 900,
    minHeight: 600,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: "#0e0f11",
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
    webPreferences: {
      preload: options.preloadFile,
      // Renderer gets no direct Node access (spec §5).
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: false,
    },
  });

  window.once("ready-to-show", () => window.show());

  // External links open in the user's browser, never inside the app shell.
  window.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: "deny" };
  });

  if (options.devServerUrl) {
    void window.loadURL(options.devServerUrl);
  } else {
    void window.loadFile(options.rendererFile);
  }

  return window;
}

export function resolveRendererFile(appDirectory: string): string {
  return join(appDirectory, "../renderer/index.html");
}
