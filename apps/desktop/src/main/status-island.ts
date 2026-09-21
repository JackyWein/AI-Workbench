import { join } from "node:path";
import { BrowserWindow, screen, type Display } from "electron";
import {
  ISLAND_STATE_CHANNEL,
  type IslandPreferences,
  type IslandState,
  type Logger,
} from "@ai-workbench/shared";

/**
 * The floating companion window (spec §95).
 *
 * It is a window of its own with its own lifecycle: hiding, minimizing or
 * closing the main window does not touch it, which is the whole point — the
 * user should be able to see what is happening without the app in front of
 * them.
 */

const COMPACT = { width: 320, height: 44 } as const;
const EXPANDED = { width: 380, height: 132 } as const;
const MARGIN = 12;

export interface StatusIslandOptions {
  readonly logger: Logger;
  readonly islandFile: string;
  readonly devServerUrl?: string | undefined;
  readonly preloadFile: string;
  /** Persists a position the user dragged the island to. */
  readonly onMoved: (position: { x: number; y: number; displayId: number }) => void;
}

export class StatusIslandWindow {
  readonly #logger: Logger;
  readonly #options: StatusIslandOptions;
  #window: BrowserWindow | null = null;
  #preferences: IslandPreferences | null = null;
  #lastState: IslandState | null = null;
  #expanded = false;
  /** True while the position is set programmatically, not dragged. */
  #placing = false;

  constructor(options: StatusIslandOptions) {
    this.#options = options;
    this.#logger = options.logger.child("STATUS_ISLAND");
  }

  get visible(): boolean {
    return this.#window !== null && !this.#window.isDestroyed() && this.#window.isVisible();
  }

  /**
   * Stores the preferences and window chrome without changing visibility, so
   * showing the island later works even when it did not start with the app.
   */
  configure(preferences: IslandPreferences): void {
    this.#preferences = preferences;
    if (!preferences.enabled) {
      return;
    }
    const window = this.#ensure();
    window.setAlwaysOnTop(preferences.alwaysOnTop, "floating");
    this.#place(window, preferences);
  }

  /** Brings the island in line with the preferences, creating or closing it. */
  apply(preferences: IslandPreferences): void {
    this.configure(preferences);
    if (!preferences.enabled) {
      this.hide();
      return;
    }
    const window = this.#ensure();
    if (!window.isVisible()) {
      window.showInactive();
    }
  }

  show(): void {
    if (!this.#preferences?.enabled) {
      return;
    }
    this.apply(this.#preferences);
  }

  hide(): void {
    if (this.#window && !this.#window.isDestroyed()) {
      this.#window.hide();
    }
  }

  toggle(): boolean {
    if (this.visible) {
      this.hide();
      return false;
    }
    this.show();
    return this.visible;
  }

  /** Pushes new state and resizes when an entry needs the room (spec §97). */
  render(state: IslandState): void {
    this.#lastState = state;
    // Self-heal: an enabled island without a live window comes back instead
    // of staying invisible forever (e.g. after a crash of the window).
    if (this.#preferences?.enabled) {
      const window = this.#window;
      if (!window || window.isDestroyed()) {
        this.apply(this.#preferences);
        return;
      }
    }
    const window = this.#window;
    if (!window || window.isDestroyed()) {
      return;
    }

    try {
      window.webContents.send(ISLAND_STATE_CHANNEL, state);
    } catch (error) {
      this.#logger.warn("Could not push island state", {
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    }

    const wantsExpanded = state.expanded && Boolean(state.current.action);
    if (wantsExpanded !== this.#expanded) {
      this.#expanded = wantsExpanded;
      const size = wantsExpanded ? EXPANDED : COMPACT;
      window.setBounds({ ...window.getBounds(), ...size }, false);
      if (this.#preferences) {
        this.#place(window, this.#preferences);
      }
    }
  }

  destroy(): void {
    const window = this.#window;
    this.#window = null;
    if (!window || window.isDestroyed()) {
      return;
    }
    window.removeAllListeners("moved");
    try {
      window.webContents.removeAllListeners("did-finish-load");
    } catch {
      // The web contents may already be gone; destroying the window is what
      // matters.
    }
    window.destroy();
  }

  #ensure(): BrowserWindow {
    if (this.#window && !this.#window.isDestroyed()) {
      return this.#window;
    }

    const window = new BrowserWindow({
      ...COMPACT,
      show: false,
      frame: false,
      transparent: true,
      backgroundColor: "#00000000",
      resizable: false,
      movable: true,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      // Focusable on every platform so keyboard switching works (spec §100).
      // Programmatic shows still use showInactive and never steal focus.
      focusable: true,
      hasShadow: false,
      webPreferences: {
        preload: this.#options.preloadFile,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });

    window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

    // A dragged island remembers where it was put (spec §95). Positions set
    // programmatically must not echo back, or placing the window would
    // persist itself in a loop.
    window.on("moved", () => {
      if (this.#placing) {
        return;
      }
      const bounds = window.getBounds();
      const display = screen.getDisplayNearestPoint({ x: bounds.x, y: bounds.y });
      this.#options.onMoved({ x: bounds.x, y: bounds.y, displayId: display.id });
    });

    window.webContents.on("did-finish-load", () => {
      if (this.#lastState) {
        try {
          window.webContents.send(ISLAND_STATE_CHANNEL, this.#lastState);
        } catch (error) {
          this.#logger.warn("Could not push island state after load", {
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    });

    if (this.#options.devServerUrl) {
      window
        .loadURL(`${this.#options.devServerUrl}island/index.html`)
        .catch((error: unknown) =>
          this.#logger.warn("Could not load the island page", {
            error: error instanceof Error ? error.message : String(error),
          }),
        );
    } else {
      window
        .loadFile(this.#options.islandFile)
        .catch((error: unknown) =>
          this.#logger.warn("Could not load the island page", {
            error: error instanceof Error ? error.message : String(error),
          }),
        );
    }

    this.#window = window;
    this.#logger.info("Status Island window created");
    return window;
  }

  /** Multi-monitor aware placement, clamped into the chosen display. */
  #place(window: BrowserWindow, preferences: IslandPreferences | null): void {
    if (!preferences) {
      return;
    }
    const display = resolveDisplay(preferences.displayId);
    const { x, y, width } = display.workArea;
    const bounds = window.getBounds();

    const position = ((): { x: number; y: number } => {
      switch (preferences.position) {
        case "topLeft":
          return { x: x + MARGIN, y: y + MARGIN };
        case "topRight":
          return { x: x + width - bounds.width - MARGIN, y: y + MARGIN };
        case "custom": {
          // Stored coordinates may be stale, missing or non-finite (a display
          // was unplugged, settings were edited by hand). Fall back to a
          // visible default; clampToDisplay below keeps the result on-screen.
          const customX =
            typeof preferences.customX === "number" &&
            Number.isFinite(preferences.customX)
              ? preferences.customX
              : x + Math.round((width - bounds.width) / 2);
          const customY =
            typeof preferences.customY === "number" &&
            Number.isFinite(preferences.customY)
              ? preferences.customY
              : y + MARGIN;
          return { x: customX, y: customY };
        }
        default:
          return { x: x + Math.round((width - bounds.width) / 2), y: y + MARGIN };
      }
    })();

    const [left, top] = clampToDisplay(position, bounds, display);
    this.#placing = true;
    try {
      window.setPosition(left, top);
    } finally {
      this.#placing = false;
    }
  }
}

/** The configured display when it still exists, otherwise the active one. */
export function resolveDisplay(displayId: number | null): Display {
  try {
    const displays = screen.getAllDisplays();
    const chosen =
      displayId === null
        ? undefined
        : displays.find((display) => display.id === displayId);
    if (chosen) {
      return chosen;
    }
    // A display that was unplugged must not strand the island off-screen.
    return screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  } catch {
    // Headless environments (verify:app under Xvfb without monitors) may have
    // no display at all; fall back to the primary one, which Electron still
    // provides as a best-effort work area.
    return screen.getPrimaryDisplay();
  }
}

/** Keeps the island inside the display, whatever was stored earlier. */
export function clampToDisplay(
  position: { x: number; y: number },
  size: { width: number; height: number },
  display: Display,
): [number, number] {
  const area = display.workArea;
  const width = Number.isFinite(size.width) ? size.width : 0;
  const height = Number.isFinite(size.height) ? size.height : 0;
  const rawX = Number.isFinite(position.x) ? position.x : area.x;
  const rawY = Number.isFinite(position.y) ? position.y : area.y;
  const x = Math.min(Math.max(rawX, area.x), area.x + area.width - width);
  const y = Math.min(Math.max(rawY, area.y), area.y + area.height - height);
  return [Math.round(x), Math.round(y)];
}

export function resolveIslandFile(appDirectory: string): string {
  return join(appDirectory, "../renderer/island/index.html");
}
