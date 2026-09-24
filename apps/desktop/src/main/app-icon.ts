import { nativeImage } from "electron";
import type { Theme } from "@ai-workbench/shared";

/** One theme's version of the app mark. Colours as #rrggbb. */
export interface MarkPalette {
  /** The rounded square behind the bars. */
  readonly plate: string;
  /** The three bars. */
  readonly bars: string;
  /** Corner radius of the plate, in the 16-unit design space. */
  readonly radius: number;
}

/**
 * The mark in each theme — the same shape, the theme's own plate and accent,
 * so the taskbar, the window and the tray match the app the person chose.
 * Only the theme decides it, not light or dark: an icon on a taskbar does not
 * switch with the window's mode, and flipping it would only look unsteady.
 * Colours come from each theme's tokens in packages/ui/src/themes.css.
 */
export const THEME_MARKS: Readonly<Record<Theme, MarkPalette>> = {
  quiet: { plate: "#16191d", bars: "#6aa8ff", radius: 3.6 },
  atelier: { plate: "#1c1814", bars: "#e39a72", radius: 4.2 },
  mission: { plate: "#0b0d0c", bars: "#c6f432", radius: 2 },
  playground: { plate: "#1a1838", bars: "#ff6b4a", radius: 4.8 },
  aurora: { plate: "#0d0f24", bars: "#a497ff", radius: 4 },
  swiss: { plate: "#e30613", bars: "#ffffff", radius: 0.6 },
};

/** Sizes an icon carries so every place that shows it picks a sharp one. */
const ICON_SIZES = [16, 24, 32, 48, 64, 128, 256] as const;

/** The mark as a multi-resolution image, for a window, the taskbar or the dock. */
export function appIconImage(theme: Theme): Electron.NativeImage {
  const palette = THEME_MARKS[theme] ?? THEME_MARKS.quiet;
  const [first, ...rest] = ICON_SIZES;
  const image = nativeImage.createFromBuffer(drawMark(first, palette), {
    width: first,
    height: first,
  });
  for (const size of rest) {
    image.addRepresentation({
      buffer: drawMark(size, palette),
      width: size,
      height: size,
      scaleFactor: size / first,
    });
  }
  return image;
}

/** The mark for the tray, at 1× and 2× so it stays sharp on scaled displays. */
export function trayIconImage(theme: Theme): Electron.NativeImage {
  const palette = THEME_MARKS[theme] ?? THEME_MARKS.quiet;
  const image = nativeImage.createFromBuffer(drawMark(16, palette), {
    width: 16,
    height: 16,
    scaleFactor: 1,
  });
  image.addRepresentation({ buffer: drawMark(32, palette), width: 32, height: 32, scaleFactor: 2 });
  return image;
}

interface Shape {
  readonly x0: number;
  readonly y0: number;
  readonly x1: number;
  readonly y1: number;
  readonly radius: number;
  /** Straight BGR; premultiplied when written. */
  readonly color: readonly [number, number, number];
  readonly alpha: number;
}

/** Coverage of a rounded rectangle at a point, in 16-unit design space. */
function covers(shape: Shape, x: number, y: number): boolean {
  if (x < shape.x0 || x > shape.x1 || y < shape.y0 || y > shape.y1) {
    return false;
  }
  const radius = Math.max(0, shape.radius);
  const cx = Math.min(Math.max(x, shape.x0 + radius), shape.x1 - radius);
  const cy = Math.min(Math.max(y, shape.y0 + radius), shape.y1 - radius);
  return (x - cx) ** 2 + (y - cy) ** 2 <= radius ** 2;
}

/** "#rrggbb" as the BGR triple the bitmap wants. */
function bgr(hex: string): [number, number, number] {
  const value = Number.parseInt(hex.replace("#", ""), 16);
  return [value & 0xff, (value >> 8) & 0xff, (value >> 16) & 0xff];
}

/**
 * The app mark, drawn rather than shipped so there is no asset to lose in
 * packaging: a rounded plate with three bars of falling length. Anti-aliased
 * by supersampling; returns BGRA with premultiplied alpha, as Electron's
 * `createFromBuffer` expects.
 */
export function drawMark(size: number, palette: MarkPalette): Buffer {
  const bars = bgr(palette.bars);
  const shapes: Shape[] = [
    { x0: 0.5, y0: 0.5, x1: 15.5, y1: 15.5, radius: palette.radius, color: bgr(palette.plate), alpha: 1 },
    { x0: 3.6, y0: 3.7, x1: 12.4, y1: 5.9, radius: 1.1, color: bars, alpha: 1 },
    { x0: 3.6, y0: 6.9, x1: 10.2, y1: 9.1, radius: 1.1, color: bars, alpha: 1 },
    { x0: 3.6, y0: 10.1, x1: 7.8, y1: 12.3, radius: 1.1, color: bars, alpha: 0.6 },
  ];
  // Small sizes need more samples per pixel to stay smooth; large ones do not.
  const samples = size <= 32 ? 4 : 2;
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
          // Shapes painted back to front, straight alpha "over".
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
      // Colours were accumulated against transparency: already premultiplied.
      buffer[offset] = Math.round(b / n);
      buffer[offset + 1] = Math.round(g / n);
      buffer[offset + 2] = Math.round(r / n);
      buffer[offset + 3] = Math.round((a / n) * 255);
    }
  }
  return buffer;
}
