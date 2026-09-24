import { join } from "node:path";
import { BrowserWindow, screen, type Display } from "electron";
import {
  ISLAND_DRAG_CHANNEL,
  ISLAND_STATE_CHANNEL,
  ISLAND_THEME_CHANNEL,
  type IslandDrag,
  type IslandEdge,
  type IslandPreferences,
  type IslandState,
  type Logger,
  type Theme,
} from "@ai-workbench/shared";
import {
  anchorResize,
  dockPoint,
  dragFrame,
  edgeDistances,
  px,
  railOf,
  settleEase,
  type Point,
  type Rect,
  type Size,
} from "./island-helpers.js";

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
/** Drag and settle frames; the pointer is sampled on this beat. */
const FRAME_MS = 8;
/** How long a released unit takes to settle onto its rail. */
const SETTLE_MS = 320;
/** A drag the page never ended (it crashed, lost the pointer) ends here. */
const DRAG_LIMIT_MS = 120_000;

/** Where the island came to rest after a drag, for persisting. */
export interface IslandSettle {
  readonly dockedEdge: IslandEdge | null;
  /** Along-rail center when docked, else null. */
  readonly railT: number | null;
  readonly x: number;
  readonly y: number;
  readonly displayId: number;
}

export interface StatusIslandOptions {
  readonly logger: Logger;
  readonly islandFile: string;
  readonly devServerUrl?: string | undefined;
  readonly preloadFile: string;
  /**
   * Persists where a drag left the island: docked on a rail at a spot, or a
   * free blob at a position.
   */
  readonly onSettle: (settle: IslandSettle) => void;
}

interface DragSession {
  /** Where the unit is held, as a fraction of the window. */
  grab: Point;
  edge: IslandEdge | null;
  snap: IslandEdge | null;
  depth: number;
  readonly startedAt: number;
}

interface Settling {
  readonly from: Point;
  readonly startedAt: number;
  /** Recomputed every frame, so a size change mid-flight still lands true. */
  readonly target: (size: Size) => Point;
}

export class StatusIslandWindow {
  readonly #logger: Logger;
  readonly #options: StatusIslandOptions;
  #window: BrowserWindow | null = null;
  #preferences: IslandPreferences | null = null;
  #lastState: IslandState | null = null;
  #theme: Theme = "dark";
  #drag: DragSession | null = null;
  #dragTimer: NodeJS.Timeout | null = null;
  #settling: Settling | null = null;
  #settleTimer: NodeJS.Timeout | null = null;

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
    // On Windows the island must survive full-screen apps: "floating" loses
    // to exclusive/borderless full-screen windows, "screen-saver" sits above
    // everything the desktop draws. (A truly exclusive full-screen mode on a
    // monitor that bypasses the desktop compositor still cannot be covered by
    // any window; that is an OS limit, not ours.) Re-applied on every
    // configure so a later z-order change cannot pin us below another app.
    window.setAlwaysOnTop(
      preferences.alwaysOnTop,
      process.platform === "win32" ? "screen-saver" : "floating",
    );
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
    if (this.#drag) {
      this.endDrag();
    }
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

  /** The app's theme; the island draws in the same one. */
  setTheme(theme: Theme): void {
    this.#theme = theme;
    const window = this.#window;
    if (!window || window.isDestroyed()) {
      return;
    }
    try {
      window.webContents.send(ISLAND_THEME_CHANNEL, theme);
    } catch (error) {
      this.#logger.warn("Could not push the theme to the island", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
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
   * Applies the size the island page measured for its current face. A docked
   * unit stays on its rail at its spot, growing away from the edge, so the
   * pill opens in place; a free blob keeps its left side and vertical center.
   * Mid-drag or mid-settle the frame loop owns the position.
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
    const size = { width, height };
    // Mid-drag or mid-settle the new size and its position land together,
    // so the unit never sits off its rail inside a window of the old size.
    if (this.#drag) {
      this.#dragTick(size);
      return;
    }
    if (this.#settling) {
      this.#settleTick(size);
      return;
    }
    const display = displayUnder(bounds);
    const edge = this.#preferences?.dockedEdge ?? null;
    if (edge) {
      const point = dockPoint(edge, this.#preferences?.railT ?? null, size, display.workArea);
      window.setBounds({ ...point, ...size }, false);
      return;
    }
    const anchored = anchorResize(bounds, size, null);
    const [left, top] = clampToDisplay(anchored, size, display);
    window.setBounds({ x: left, y: top, width, height }, false);
  }

  /**
   * The page grabbed the unit. From here the window follows the pointer on a
   * short beat until `endDrag`, sampled from the OS cursor, so a fast flick
   * that outruns the window never drops the unit.
   */
  beginDrag(grabX: number, grabY: number): boolean {
    const window = this.#window;
    if (!window || window.isDestroyed()) {
      return false;
    }
    this.#stopSettling();
    this.#stopDragTimer();
    const bounds = window.getBounds();
    const edge = this.#preferences?.dockedEdge ?? null;
    const pointer = screen.getCursorScreenPoint();
    const area = screen.getDisplayNearestPoint(pointer).workArea;
    this.#drag = {
      grab: {
        x: bounds.width > 0 ? Math.min(Math.max(grabX / bounds.width, 0), 1) : 0.5,
        y: bounds.height > 0 ? Math.min(Math.max(grabY / bounds.height, 0), 1) : 0.5,
      },
      edge,
      snap: null,
      depth: edge ? Math.max(0, edgeDistances(pointer, area)[edge]) : 0,
      startedAt: Date.now(),
    };
    this.#sendDrag({ active: true, edge, snap: null });
    this.#dragTimer = setInterval(() => this.#dragTick(), FRAME_MS);
    return true;
  }

  /**
   * The pointer let go. A pill settles onto its rail, springing back from any
   * pull; a blob released near an edge flies there and docks; anywhere else
   * the blob stays where it was put. The outcome is persisted either way.
   */
  endDrag(): boolean {
    if (!this.#drag) {
      return false;
    }
    this.#dragTick();
    const drag = this.#drag;
    this.#stopDragTimer();
    this.#drag = null;
    const window = this.#window;
    if (!drag || !window || window.isDestroyed()) {
      return false;
    }
    const bounds = window.getBounds();
    const display = displayUnder(bounds);
    const area = display.workArea;
    const edge = drag.edge ?? drag.snap;
    if (!edge) {
      this.#adopt({
        dockedEdge: null,
        railT: null,
        position: "custom",
        customX: bounds.x,
        customY: bounds.y,
        displayId: display.id,
      });
      this.#sendDrag({ active: false, edge: null, snap: null });
      this.#options.onSettle({
        dockedEdge: null,
        railT: null,
        x: bounds.x,
        y: bounds.y,
        displayId: display.id,
      });
      return false;
    }
    const railT = railOf(edge, bounds, area);
    this.#adopt({ dockedEdge: edge, railT, displayId: display.id });
    this.#sendDrag({ active: false, edge, snap: null });
    this.#settleTo((size) => dockPoint(edge, railT, size, area));
    this.#options.onSettle({
      dockedEdge: edge,
      railT,
      x: bounds.x,
      y: bounds.y,
      displayId: display.id,
    });
    return false;
  }

  destroy(): void {
    this.#stopDragTimer();
    this.#stopSettling();
    this.#drag = null;
    const window = this.#window;
    this.#window = null;
    if (!window || window.isDestroyed()) {
      return;
    }
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

    window.webContents.on("did-finish-load", () => {
      try {
        window.webContents.send(ISLAND_THEME_CHANNEL, this.#theme);
      } catch (error) {
        this.#logger.warn("Could not push the theme to the island after load", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
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

  #dragTick(resized?: Size): void {
    const window = this.#window;
    const drag = this.#drag;
    if (!window || window.isDestroyed() || !drag) {
      this.#stopDragTimer();
      return;
    }
    if (Date.now() - drag.startedAt > DRAG_LIMIT_MS) {
      this.endDrag();
      return;
    }
    const pointer = screen.getCursorScreenPoint();
    const area = screen.getDisplayNearestPoint(pointer).workArea;
    const bounds = window.getBounds();
    const size = resized ?? { width: bounds.width, height: bounds.height };
    const frame = dragFrame({
      pointer,
      grab: drag.grab,
      size,
      area,
      edge: drag.edge,
      depth: drag.depth,
      snap: drag.snap,
    });
    if (frame.regrab) {
      drag.grab = { x: 0.5, y: 0.5 };
    }
    drag.depth = frame.depth;
    moveWindow(window, bounds, { x: frame.x, y: frame.y, ...size });
    if (frame.edge !== drag.edge || frame.snap !== drag.snap) {
      drag.edge = frame.edge;
      drag.snap = frame.snap;
      this.#sendDrag({ active: true, edge: frame.edge, snap: frame.snap });
    }
  }

  #settleTo(target: (size: Size) => Point): void {
    const window = this.#window;
    if (!window || window.isDestroyed()) {
      return;
    }
    this.#stopSettling();
    const bounds = window.getBounds();
    this.#settling = { from: { x: bounds.x, y: bounds.y }, startedAt: Date.now(), target };
    this.#settleTimer = setInterval(() => this.#settleTick(), FRAME_MS);
  }

  #settleTick(resized?: Size): void {
    const window = this.#window;
    const settling = this.#settling;
    if (!window || window.isDestroyed() || !settling) {
      this.#stopSettling();
      return;
    }
    const t = Math.min(1, (Date.now() - settling.startedAt) / SETTLE_MS);
    const eased = settleEase(t);
    const bounds = window.getBounds();
    const size = resized ?? { width: bounds.width, height: bounds.height };
    const to = settling.target(size);
    const x = px(settling.from.x + (to.x - settling.from.x) * eased);
    const y = px(settling.from.y + (to.y - settling.from.y) * eased);
    moveWindow(window, bounds, { x, y, ...size });
    if (t >= 1) {
      this.#stopSettling();
    }
  }

  #stopDragTimer(): void {
    if (this.#dragTimer) {
      clearInterval(this.#dragTimer);
      this.#dragTimer = null;
    }
  }

  #stopSettling(): void {
    if (this.#settleTimer) {
      clearInterval(this.#settleTimer);
      this.#settleTimer = null;
    }
    this.#settling = null;
  }

  /**
   * Takes a drag's outcome on at once, ahead of the persisted preferences
   * coming back, so sizing in between already anchors to the new rail.
   */
  #adopt(patch: Partial<IslandPreferences>): void {
    if (this.#preferences) {
      this.#preferences = { ...this.#preferences, ...patch };
    }
  }

  #sendDrag(drag: IslandDrag): void {
    const window = this.#window;
    if (!window || window.isDestroyed()) {
      return;
    }
    try {
      window.webContents.send(ISLAND_DRAG_CHANNEL, drag);
    } catch (error) {
      this.#logger.warn("Could not push island drag state", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /** Multi-monitor aware placement, clamped into the chosen display. */
  #place(window: BrowserWindow, preferences: IslandPreferences | null): void {
    if (!preferences) {
      return;
    }
    // A drag or a settle in flight owns the position; it lands on the same
    // spot the preferences describe.
    if (this.#drag || this.#settling) {
      return;
    }
    const display = resolveDisplay(preferences.displayId);
    const bounds = window.getBounds();

    if (preferences.dockedEdge) {
      const point = dockPoint(preferences.dockedEdge, preferences.railT, bounds, display.workArea);
      window.setPosition(point.x, point.y);
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
    window.setPosition(left, top);
  }
}

/** Moves (and resizes) the window in one step, only when something changed. */
function moveWindow(window: BrowserWindow, bounds: Rect, next: Rect): void {
  if (
    next.x === bounds.x &&
    next.y === bounds.y &&
    next.width === bounds.width &&
    next.height === bounds.height
  ) {
    return;
  }
  window.setBounds(next, false);
}

/** The display a window mostly sits on, judged by its center. */
function displayUnder(bounds: Rect): Display {
  return screen.getDisplayNearestPoint({
    x: bounds.x + Math.round(bounds.width / 2),
    y: bounds.y + Math.round(bounds.height / 2),
  });
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
  return [px(x), px(y)];
}

export function resolveIslandFile(appDirectory: string): string {
  return join(appDirectory, "../renderer/island/index.html");
}
