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

  constructor(options: StatusIslandOptions) {
    this.#options = options;
    this.#logger = options.logger.child("STATUS_ISLAND");
  }

  get visible(): boolean {
    return this.#window !== null && !this.#window.isDestroyed() && this.#window.isVisible();
  }

  /** Brings the island in line with the preferences, creating or closing it. */
  apply(preferences: IslandPreferences): void {
    this.#preferences = preferences;
    if (!preferences.enabled) {
      this.hide();
      return;
    }
    const window = this.#ensure();
    window.setAlwaysOnTop(preferences.alwaysOnTop, "floating");
    this.#place(window, preferences);
    if (!window.isVisible()) {
      window.showInactive();
    }
  }

  show(): void {
    if (!this.#preferences?.enabled) {
      return;
    }
    const window = this.#ensure();
    this.#place(window, this.#preferences);
    window.showInactive();
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
    const window = this.#window;
    if (!window || window.isDestroyed()) {
      return;
    }

    window.webContents.send(ISLAND_STATE_CHANNEL, state);

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
    if (this.#window && !this.#window.isDestroyed()) {
      this.#window.destroy();
    }
    this.#window = null;
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
      // It is a companion, not a window to work in.
      focusable: process.platform !== "linux",
      hasShadow: false,
      webPreferences: {
        preload: this.#options.preloadFile,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });

    window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

    // A dragged island remembers where it was put (spec §95).
    window.on("moved", () => {
      const bounds = window.getBounds();
      const display = screen.getDisplayNearestPoint({ x: bounds.x, y: bounds.y });
      this.#options.onMoved({ x: bounds.x, y: bounds.y, displayId: display.id });
    });

    window.webContents.on("did-finish-load", () => {
      if (this.#lastState) {
        window.webContents.send(ISLAND_STATE_CHANNEL, this.#lastState);
      }
    });

    if (this.#options.devServerUrl) {
      void window.loadURL(`${this.#options.devServerUrl}island/index.html`);
    } else {
      void window.loadFile(this.#options.islandFile);
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
        case "custom":
          return {
            x: preferences.customX ?? x + Math.round((width - bounds.width) / 2),
            y: preferences.customY ?? y + MARGIN,
          };
        default:
          return { x: x + Math.round((width - bounds.width) / 2), y: y + MARGIN };
      }
    })();

    const [left, top] = clampToDisplay(position, bounds, display);
    window.setPosition(left, top);
  }
}

/** The configured display when it still exists, otherwise the active one. */
export function resolveDisplay(displayId: number | null): Display {
  const displays = screen.getAllDisplays();
  const chosen = displayId === null ? undefined : displays.find((display) => display.id === displayId);
  // A display that was unplugged must not strand the island off-screen.
  return chosen ?? screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
}

/** Keeps the island inside the display, whatever was stored earlier. */
export function clampToDisplay(
  position: { x: number; y: number },
  size: { width: number; height: number },
  display: Display,
): [number, number] {
  const area = display.workArea;
  const x = Math.min(Math.max(position.x, area.x), area.x + area.width - size.width);
  const y = Math.min(Math.max(position.y, area.y), area.y + area.height - size.height);
  return [Math.round(x), Math.round(y)];
}

export function resolveIslandFile(appDirectory: string): string {
  return join(appDirectory, "../renderer/island/index.html");
}
