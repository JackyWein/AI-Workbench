import { join } from "node:path";
import { BrowserWindow, shell } from "electron";

export interface CreateMainWindowOptions {
  readonly devServerUrl?: string | undefined;
  readonly rendererFile: string;
  readonly preloadFile: string;
  /** Window/taskbar icon while developing; packaged builds use the exe icon. */
  readonly iconFile?: string | undefined;
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
    // The renderer draws themed controls; Electron still supplies native
    // resizing, focus, snap and taskbar behaviour to the frameless window.
    frame: false,
    ...(options.iconFile ? { icon: options.iconFile } : {}),
    webPreferences: {
      preload: options.preloadFile,
      // Renderer gets no direct Node access (spec §5).
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: false,
    },
  });

  // A load that never becomes ready (failed file, hung dev server) must not
  // leave a window that never appears: fall back to showing it so the failure
  // is visible instead of a silent blank taskbar entry.
  const showFallback = setTimeout(() => {
    if (!window.isDestroyed() && !window.isVisible()) {
      window.show();
    }
  }, 10_000);
  showFallback.unref?.();

  window.once("ready-to-show", () => {
    clearTimeout(showFallback);
    if (!window.isDestroyed()) {
      window.show();
    }
  });

  window.webContents.on("did-fail-load", () => {
    if (!window.isDestroyed() && !window.isVisible()) {
      window.show();
    }
  });

  // The app shell shows local content only. Navigation to anything else —
  // links, redirects, pasted URLs — is denied; http(s) links leave through
  // the browser instead (see the window-open handler below).
  window.webContents.on("will-navigate", (event, url) => {
    if (isAllowedNavigation(url, options.devServerUrl)) {
      return;
    }
    event.preventDefault();
  });

  // External links open in the user's browser, never inside the app shell.
  // Only http(s) ever leaves the app; anything else is denied outright.
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) {
      void shell.openExternal(url);
    }
    return { action: "deny" };
  });

  if (options.devServerUrl) {
    void window.loadURL(options.devServerUrl).catch(() => {
      // The did-fail-load handler above still brings the window forward so a
      // dead dev server is visible rather than a missing window.
    });
  } else {
    void window.loadFile(options.rendererFile).catch(() => {
      // Same as above: the window is shown by the fallback paths.
    });
  }

  return window;
}

/**
 * Only the bundled file and the dev server may navigate the shell. Anything
 * else (external links, redirects) is denied; http(s) destinations leave
 * through the user's browser via the window-open handler.
 */
function isAllowedNavigation(url: string, devServerUrl?: string): boolean {
  if (url.startsWith("file:")) {
    return true;
  }
  if (devServerUrl && url.startsWith(devServerUrl)) {
    return true;
  }
  return false;
}

export function resolveRendererFile(appDirectory: string): string {
  return join(appDirectory, "../renderer/index.html");
}
