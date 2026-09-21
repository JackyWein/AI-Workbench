import { Menu, Tray, nativeImage, type BrowserWindow } from "electron";
import type { Logger } from "@ai-workbench/shared";

/**
 * The system tray (spec §104).
 *
 * Background work must never become invisible and uncontrollable, so whatever
 * is running is reachable from here even with no window on screen: open the
 * app, show the island, pause the autonomous runs, stop everything, quit.
 */
export interface TrayActions {
  readonly openMainWindow: () => void;
  readonly toggleIsland: () => boolean;
  readonly describeActivity: () => { sessions: number; runs: number };
  readonly pauseRuns: () => Promise<void>;
  readonly stopAllWork: () => Promise<void>;
  readonly quit: () => void;
}

export interface StatusTrayOptions {
  readonly logger: Logger;
  readonly actions: TrayActions;
  readonly islandVisible: () => boolean;
}

export class StatusTray {
  readonly #logger: Logger;
  readonly #options: StatusTrayOptions;
  #tray: Tray | null = null;

  constructor(options: StatusTrayOptions) {
    this.#options = options;
    this.#logger = options.logger.child("STATUS_ISLAND");
  }

  get available(): boolean {
    return this.#tray !== null && !this.#tray.isDestroyed();
  }

  create(): boolean {
    if (this.available) {
      return true;
    }
    try {
      // A tiny generated glyph, so packaging needs no separate asset and the
      // tray is never a blank square.
      this.#tray = new Tray(trayIcon());
      this.#tray.setToolTip("AI Workbench");
      this.#tray.on("click", () => this.#options.actions.openMainWindow());
      this.refresh();
      return true;
    } catch (error) {
      // Headless Linux has no tray; that is not a reason to fail to start.
      this.#logger.warn("System tray is not available", {
        error: error instanceof Error ? error.message : String(error),
      });
      this.#tray = null;
      return false;
    }
  }

  /** Rebuilds the menu so the counts in it are current, never stale. */
  refresh(): void {
    if (!this.#tray || this.#tray.isDestroyed()) {
      return;
    }
    const { sessions, runs } = this.#options.actions.describeActivity();
    const busy = sessions + runs > 0;

    this.#tray.setToolTip(
      busy
        ? `AI Workbench · ${sessions} answering, ${runs} team runs`
        : "AI Workbench · idle",
    );
    this.#tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: "Open AI Workbench", click: () => this.#options.actions.openMainWindow() },
        {
          label: this.#options.islandVisible() ? "Hide Status Island" : "Show Status Island",
          click: () => {
            this.#options.actions.toggleIsland();
            this.refresh();
          },
        },
        { type: "separator" },
        {
          label: busy
            ? `Active: ${sessions} answering, ${runs} team runs`
            : "Nothing is running",
          enabled: false,
        },
        {
          label: "Pause autonomous runs",
          enabled: runs > 0,
          click: () => {
            void this.#options.actions.pauseRuns().then(() => this.refresh());
          },
        },
        {
          label: "Stop all active work",
          enabled: busy,
          click: () => {
            void this.#options.actions.stopAllWork().then(() => this.refresh());
          },
        },
        { type: "separator" },
        { label: "Quit", click: () => this.#options.actions.quit() },
      ]),
    );
  }

  destroy(): void {
    if (this.#tray && !this.#tray.isDestroyed()) {
      this.#tray.destroy();
    }
    this.#tray = null;
  }
}

/** Hides a window to the tray instead of closing it, when asked to (spec §104). */
export function hideToTray(window: BrowserWindow): void {
  if (process.platform === "darwin") {
    window.hide();
    return;
  }
  window.hide();
}

function trayIcon(): Electron.NativeImage {
  // A 16×16 rounded square, drawn rather than shipped, so there is no asset to
  // lose in packaging.
  const size = 16;
  const buffer = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const offset = (y * size + x) * 4;
      const inside = x >= 3 && x <= 12 && y >= 3 && y <= 12;
      const corner =
        (x === 3 || x === 12) && (y === 3 || y === 12) ? true : false;
      const on = inside && !corner;
      // BGRA, premultiplied.
      buffer[offset] = on ? 0xfe : 0;
      buffer[offset + 1] = on ? 0xa8 : 0;
      buffer[offset + 2] = on ? 0x6e : 0;
      buffer[offset + 3] = on ? 0xff : 0;
    }
  }
  return nativeImage.createFromBuffer(buffer, { width: size, height: size });
}
