import { Menu, Tray, type BrowserWindow, type MenuItemConstructorOptions } from "electron";
import type { Logger, Theme } from "@ai-workbench/shared";
import { trayIconImage } from "./app-icon.js";

/**
 * The system tray (spec §104).
 *
 * Background work must never become invisible and uncontrollable, so whatever
 * is running is reachable from here even with no window on screen: open the
 * app, show the island, pause the autonomous runs, stop everything, quit.
 */
export interface TrayActions {
  /** Brings the main window forward; may return it for restore/show/focus. */
  readonly openMainWindow: () => BrowserWindow | null | void;
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
  /** The mark follows the theme the app is set to, as the window icon does. */
  #theme: Theme = "quiet";

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
      this.#tray = new Tray(trayIconImage(this.#theme));
      this.#tray.setToolTip("AI Workbench");
      this.#tray.on("click", () => this.#openMainWindow());
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

  /** Repaints the tray mark in a theme's colours. */
  setTheme(theme: Theme): void {
    if (theme === this.#theme) {
      return;
    }
    this.#theme = theme;
    if (this.available) {
      this.#tray?.setImage(trayIconImage(theme));
    }
  }

  /** Rebuilds the menu so the counts in it are current, never stale. */
  refresh(): void {
    if (!this.#tray || this.#tray.isDestroyed()) {
      return;
    }
    const { sessions, runs } = this.#options.actions.describeActivity();
    const busy = sessions + runs > 0;

    this.#tray.setToolTip(busy ? `AI Workbench · ${activityLine(sessions, runs)}` : "AI Workbench");
    // Short and calm: what can be done right now, nothing greyed out. The
    // work controls only appear while there is work to control.
    const work: MenuItemConstructorOptions[] = busy
      ? [
          { type: "separator" },
          { label: activityLine(sessions, runs), enabled: false },
          ...(runs > 0
            ? [
                {
                  label: "Pause team runs",
                  click: () => {
                    // The menu always refreshes, even when pausing failed —
                    // otherwise a failure leaves stale counts behind and an
                    // unhandled rejection.
                    void this.#options.actions
                      .pauseRuns()
                      .catch((error: unknown) => {
                        this.#logger.warn("Pausing runs from the tray failed", {
                          error: error instanceof Error ? error.message : String(error),
                        });
                      })
                      .then(() => this.refresh());
                  },
                },
              ]
            : []),
          {
            label: "Stop all work",
            click: () => {
              void this.#options.actions
                .stopAllWork()
                .catch((error: unknown) => {
                  this.#logger.warn("Stopping work from the tray failed", {
                    error: error instanceof Error ? error.message : String(error),
                  });
                })
                .then(() => this.refresh());
            },
          },
        ]
      : [];
    this.#tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: "Open AI Workbench", click: () => this.#openMainWindow() },
        {
          label: this.#options.islandVisible() ? "Hide Status Island" : "Show Status Island",
          click: () => {
            this.#options.actions.toggleIsland();
            this.refresh();
          },
        },
        ...work,
        { type: "separator" },
        { label: "Quit AI Workbench", click: () => this.#options.actions.quit() },
      ]),
    );
  }

  destroy(): void {
    if (this.#tray && !this.#tray.isDestroyed()) {
      this.#tray.destroy();
    }
    this.#tray = null;
  }

  /** Brings the main window forward from a tray click or menu entry. */
  #openMainWindow(): void {
    try {
      const window = this.#options.actions.openMainWindow();
      // The action focuses the window itself, but a minimized or hidden
      // window needs restoring and showing first — do it here so every tray
      // entry point behaves the same.
      if (window && typeof window === "object" && !window.isDestroyed()) {
        if (window.isMinimized()) {
          window.restore();
        }
        if (!window.isVisible()) {
          window.show();
        }
        window.focus();
      }
    } catch (error) {
      this.#logger.warn("Opening the main window from the tray failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    this.refresh();
  }
}

/** Hides a window to the tray instead of closing it, when asked to (spec §104). */
export function hideToTray(window: BrowserWindow): void {
  window.hide();
}

/** "2 agents working · 1 team run", counting only what is there. */
function activityLine(sessions: number, runs: number): string {
  const parts: string[] = [];
  if (sessions > 0) {
    parts.push(`${sessions} ${sessions === 1 ? "agent" : "agents"} working`);
  }
  if (runs > 0) {
    parts.push(`${runs} team ${runs === 1 ? "run" : "runs"}`);
  }
  return parts.join(" · ");
}
