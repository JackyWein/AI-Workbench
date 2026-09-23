import { join } from "node:path";
import { BrowserWindow, screen, type Display } from "electron";
import {
  ISLAND_STATE_CHANNEL,
  ISLAND_TIMING,
  type IslandEdge,
  type IslandPreferences,
  type IslandState,
  type Logger,
} from "@ai-workbench/shared";
import { anchorResize } from "./island-helpers.js";

/**
 * The floating companion window (spec §95).
 *
 * It is a window of its own with its own lifecycle: hiding, minimizing or
 * closing the main window does not touch it, which is the whole point — the
 * user should be able to see what is happening without the app in front of
 * them.
 */

const COMPACT = { width: 320, height: 44 } as const;
const MARGIN = 12;

export interface StatusIslandOptions {
  readonly logger: Logger;
  readonly islandFile: string;
  readonly devServerUrl?: string | undefined;
  readonly preloadFile: string;
  /** Persists a position the user dragged the island to. */
  readonly onMoved: (position: { x: number; y: number; displayId: number }) => void;
  /** A released blob settled near a rail and should dock to it. */
  readonly onSnapEdge: (snap: { edge: IslandEdge; railT: number; displayId: number }) => void;
  /** A docked pill was pulled off its rail and is a free blob again. */
  readonly onDetach: (position: { x: number; y: number; displayId: number }) => void;
}

export class StatusIslandWindow {
  readonly #logger: Logger;
  readonly #options: StatusIslandOptions;
  #window: BrowserWindow | null = null;
  #preferences: IslandPreferences | null = null;
  #lastState: IslandState | null = null;
  /** True while the position is set programmatically, not dragged. */
  #placing = false;
  #snapTimer: NodeJS.Timeout | null = null;

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

  /** Pushes new state; sizing belongs to the page, which reports it back. */
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
  }

  /**
   * Applies the size the island page measured for its current face. Position
   * is kept; the result is clamped into the display so a tall card cannot
   * strand itself half off-screen.
   */
  setContentSize(width: number, height: number): void {
    const window = this.#window;
    if (!window || window.isDestroyed()) {
      return;
    }
    const bounds = window.getBounds();
    if (bounds.width === width && bounds.height === height) {
      return;
    }
    const display = screen.getDisplayNearestPoint({ x: bounds.x, y: bounds.y });
    const anchored = anchorResize(bounds, { width, height }, this.#preferences?.dockedEdge ?? null);
    const [left, top] = clampToDisplay(anchored, { width, height }, display);
    this.#placing = true;
    try {
      window.setBounds({ x: left, y: top, width, height }, false);
    } finally {
      this.#placing = false;
    }
  }

  destroy(): void {
    if (this.#snapTimer) {
      clearTimeout(this.#snapTimer);
      this.#snapTimer = null;
    }
    const window = this.#window;
    this.#window = null;
    if (!window || window.isDestroyed()) {
      return;
    }
    window.removeAllListeners("moved");
    try {
      window.webContents.removeAllListeners("did-finish-load");
      window.webContents.removeAllListeners("did-fail-load");
      window.webContents.removeAllListeners("console-message");
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

    // A blank companion is undebuggable: page load failures and page console
    // output (including uncaught renderer exceptions) are forwarded to the
    // main log, so the terminal names the cause instead of silence.
    window.webContents.on(
      "did-fail-load",
      (_event, errorCode, errorDescription, validatedURL) => {
        this.#logger.warn("Island page failed to load", {
          errorCode,
          errorDescription,
          validatedURL,
        });
      },
    );
    window.webContents.on("console-message", (details) => {
      const where = `${details.sourceId}:${details.lineNumber}`;
      if (details.level === "error" || details.level === "warning") {
        this.#logger.warn("Island console error", { message: details.message, where });
      } else {
        this.#logger.info("Island console", { message: details.message, where });
      }
    });

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
      // Edge-dock settles after the drag, never during it: repositioning
      // mid-drag would fight the pointer. When `moved` stops firing the
      // island has been released (or paused) and snapping is safe.
      if (this.#snapTimer) {
        clearTimeout(this.#snapTimer);
      }
      this.#snapTimer = setTimeout(() => {
        this.#snapTimer = null;
        this.#settleToRail(window);
      }, 350);
      this.#snapTimer.unref?.();
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
      // The dev server URL may or may not end in a slash; either way the
      // island page must resolve under it, not beside it.
      const base = this.#options.devServerUrl.replace(/\/+$/, "");
      window
        .loadURL(`${base}/island/index.html`)
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

  /**
   * Settles a dragged island to its rail. A free blob released near an edge
   * docks; a docked pill pulled off its rail becomes a free blob. Runs only
   * after movement stopped, so it never fights an active drag.
   */
  #settleToRail(window: BrowserWindow): void {
    if (window.isDestroyed() || this.#placing) {
      return;
    }
    const bounds = window.getBounds();
    const display = screen.getDisplayNearestPoint({ x: bounds.x, y: bounds.y });
    const docked = this.#preferences?.dockedEdge ?? null;
    const nearest = nearestEdge(bounds, display);

    if (docked) {
      const off = distanceFromEdge(bounds, display, docked);
      if (off > ISLAND_TIMING.detachPx) {
        this.#options.onDetach({ x: bounds.x, y: bounds.y, displayId: display.id });
      }
      return;
    }

    if (nearest && nearest.distance <= ISLAND_TIMING.snapPx) {
      this.#options.onSnapEdge({
        edge: nearest.edge,
        railT: nearest.railT,
        displayId: display.id,
      });
    }
  }

  /** Multi-monitor aware placement, clamped into the chosen display. */
  #place(window: BrowserWindow, preferences: IslandPreferences | null): void {
    if (!preferences) {
      return;
    }
    const display = resolveDisplay(preferences.displayId);
    const bounds = window.getBounds();

    if (preferences.dockedEdge) {
      const point = dockPoint(preferences.dockedEdge, preferences.railT, bounds, display);
      const [left, top] = clampToDisplay(point, bounds, display);
      this.#placing = true;
      try {
        window.setPosition(left, top);
      } finally {
        this.#placing = false;
      }
      return;
    }

    const { x, y, width } = display.workArea;

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

interface EdgeBounds {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** Perpendicular distance of a window from a rail, in pixels. */
export function distanceFromEdge(
  bounds: EdgeBounds,
  display: Display,
  edge: IslandEdge,
): number {
  const area = display.workArea;
  switch (edge) {
    case "top":
      return Math.abs(bounds.y - area.y);
    case "bottom":
      return Math.abs(area.y + area.height - (bounds.y + bounds.height));
    case "left":
      return Math.abs(bounds.x - area.x);
    case "right":
      return Math.abs(area.x + area.width - (bounds.x + bounds.width));
  }
}

/** The nearest rail with its along-rail position, for snap-on-release. */
export function nearestEdge(
  bounds: EdgeBounds,
  display: Display,
): { edge: IslandEdge; distance: number; railT: number } | null {
  const area = display.workArea;
  const candidates: Array<{ edge: IslandEdge; distance: number; railT: number }> = [
    { edge: "top", distance: Math.abs(bounds.y - area.y), railT: bounds.x - area.x },
    {
      edge: "bottom",
      distance: Math.abs(area.y + area.height - (bounds.y + bounds.height)),
      railT: bounds.x - area.x,
    },
    { edge: "left", distance: Math.abs(bounds.x - area.x), railT: bounds.y - area.y },
    {
      edge: "right",
      distance: Math.abs(area.x + area.width - (bounds.x + bounds.width)),
      railT: bounds.y - area.y,
    },
  ];
  let best: (typeof candidates)[number] | null = null;
  for (const candidate of candidates) {
    if (!best || candidate.distance < best.distance) {
      best = candidate;
    }
  }
  return best;
}

/** Where a docked pill sits on its rail; railT null means centered. */
export function dockPoint(
  edge: IslandEdge,
  railT: number | null,
  size: { width: number; height: number },
  display: Display,
): { x: number; y: number } {
  const area = display.workArea;
  const margin = ISLAND_TIMING.edgeMarginPx;
  const topOffset = 6;
  switch (edge) {
    case "top": {
      const x =
        railT === null
          ? area.x + Math.round((area.width - size.width) / 2)
          : area.x + Math.round(railT);
      return { x, y: area.y + topOffset };
    }
    case "bottom": {
      const x =
        railT === null
          ? area.x + Math.round((area.width - size.width) / 2)
          : area.x + Math.round(railT);
      return { x, y: area.y + area.height - size.height - margin };
    }
    case "left":
      return {
        x: area.x + margin,
        y:
          railT === null
            ? area.y + Math.round((area.height - size.height) / 2)
            : area.y + Math.round(railT),
      };
    case "right":
      return {
        x: area.x + area.width - size.width - margin,
        y:
          railT === null
            ? area.y + Math.round((area.height - size.height) / 2)
            : area.y + Math.round(railT),
      };
  }
}

export function resolveIslandFile(appDirectory: string): string {
  return join(appDirectory, "../renderer/island/index.html");
}
