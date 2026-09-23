import {
  Menu,
  Tray,
  nativeImage,
  type BrowserWindow,
  type MenuItemConstructorOptions,
} from "electron";
import type { Logger } from "@ai-workbench/shared";

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

/**
 * The app mark, drawn rather than shipped so there is no asset to lose in
 * packaging: a dark rounded square with three blue bars, as on the app icon.
 * Drawn at 1× and 2× so the tray stays sharp on scaled displays.
 */
function trayIcon(): Electron.NativeImage {
  const image = nativeImage.createFromBuffer(drawMark(16), {
    width: 16,
    height: 16,
    scaleFactor: 1,
  });
  image.addRepresentation({ buffer: drawMark(32), width: 32, height: 32, scaleFactor: 2 });
  return image;
}

interface Shape {
  readonly x0: number;
  readonly y0: number;
  readonly x1: number;
  readonly y1: number;
  readonly radius: number;
  /** Premultiplied later; straight BGR here. */
  readonly color: readonly [number, number, number];
  readonly alpha: number;
}

/** Coverage of a rounded rectangle at a point, in 16-unit design space. */
function covers(shape: Shape, x: number, y: number): boolean {
  if (x < shape.x0 || x > shape.x1 || y < shape.y0 || y > shape.y1) {
    return false;
  }
  const cx = Math.min(Math.max(x, shape.x0 + shape.radius), shape.x1 - shape.radius);
  const cy = Math.min(Math.max(y, shape.y0 + shape.radius), shape.y1 - shape.radius);
  return (x - cx) ** 2 + (y - cy) ** 2 <= shape.radius ** 2;
}

function drawMark(size: number): Buffer {
  const blue: [number, number, number] = [0xff, 0xa8, 0x6a];
  const shapes: Shape[] = [
    { x0: 0.5, y0: 0.5, x1: 15.5, y1: 15.5, radius: 3.6, color: [0x1d, 0x19, 0x16], alpha: 1 },
    { x0: 3.6, y0: 3.7, x1: 12.4, y1: 5.9, radius: 1.1, color: blue, alpha: 1 },
    { x0: 3.6, y0: 6.9, x1: 10.2, y1: 9.1, radius: 1.1, color: blue, alpha: 1 },
    { x0: 3.6, y0: 10.1, x1: 7.8, y1: 12.3, radius: 1.1, color: blue, alpha: 0.6 },
  ];
  const samples = 4;
  const buffer = Buffer.alloc(size * size * 4);
  const scale = 16 / size;
  for (let py = 0; py < size; py += 1) {
    for (let px = 0; px < size; px += 1) {
      let b = 0;
      let g = 0;
      let r = 0;
      let a = 0;
      for (let sy = 0; sy < samples; sy += 1) {
        for (let sx = 0; sx < samples; sx += 1) {
          const x = (px + (sx + 0.5) / samples) * scale;
          const y = (py + (sy + 0.5) / samples) * scale;
          // Paint shapes back to front, straight alpha "over".
          let cb = 0;
          let cg = 0;
          let cr = 0;
          let ca = 0;
          for (const shape of shapes) {
            if (covers(shape, x, y)) {
              const t = shape.alpha;
              cb = shape.color[0] * t + cb * (1 - t);
              cg = shape.color[1] * t + cg * (1 - t);
              cr = shape.color[2] * t + cr * (1 - t);
              ca = t + ca * (1 - t);
            }
          }
          b += cb;
          g += cg;
          r += cr;
          a += ca;
        }
      }
      const n = samples * samples;
      const offset = (py * size + px) * 4;
      // BGRA, premultiplied: colours were accumulated against transparency.
      buffer[offset] = Math.round(b / n);
      buffer[offset + 1] = Math.round(g / n);
      buffer[offset + 2] = Math.round(r / n);
      buffer[offset + 3] = Math.round((a / n) * 255);
    }
  }
  return buffer;
}
