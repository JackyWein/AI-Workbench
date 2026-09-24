import { describe, expect, it } from "vitest";
import { themeSchema } from "@ai-workbench/shared";
import { THEME_MARKS, drawMark } from "../app-icon.js";

/** The pixel at (x, y) as "#rrggbb" plus its alpha, from the BGRA buffer. */
function pixel(buffer: Buffer, size: number, x: number, y: number): { hex: string; alpha: number } {
  const offset = (y * size + x) * 4;
  const alpha = buffer[offset + 3] ?? 0;
  // Premultiplied; a fully covered pixel carries its colour as is.
  const hex = [buffer[offset + 2], buffer[offset + 1], buffer[offset]]
    .map((value) => (value ?? 0).toString(16).padStart(2, "0"))
    .join("");
  return { hex: `#${hex}`, alpha };
}

describe("the app mark in each theme", () => {
  it("has a mark for every theme the settings know", () => {
    expect(Object.keys(THEME_MARKS).sort()).toEqual([...themeSchema.options].sort());
  });

  it("draws the theme's plate and bars, so each theme's icon is its own", () => {
    const seen = new Set<string>();
    for (const theme of themeSchema.options) {
      const palette = THEME_MARKS[theme];
      const size = 64;
      const image = drawMark(size, palette);
      // Inside the first bar, and on the plate left of the bars.
      expect(pixel(image, size, 24, 19)).toEqual({ hex: palette.bars, alpha: 255 });
      expect(pixel(image, size, 6, 32)).toEqual({ hex: palette.plate, alpha: 255 });
      seen.add(`${palette.plate}/${palette.bars}`);
    }
    expect(seen.size).toBe(themeSchema.options.length);
  });

  it("keeps round corners where the theme is round and square where it is strict", () => {
    const size = 64;
    const round = pixel(drawMark(size, THEME_MARKS.quiet), size, 4, 4);
    const square = pixel(drawMark(size, THEME_MARKS.swiss), size, 4, 4);
    expect(round.alpha).toBe(0);
    expect(square.alpha).toBe(255);
  });
});
