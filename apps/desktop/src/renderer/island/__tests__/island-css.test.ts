import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/*
 * The island's window is exactly as large as the unit plus the room `.isl`
 * keeps around it. A shadow or glow that reaches further than that room is
 * cut off square at the window's edge — on a light desktop it shows as a
 * dark box around the pill. So every shadow the island draws, in every
 * theme, has to fit inside that room.
 */

const here = import.meta.dirname;
const islandCss = readFileSync(join(here, "..", "island.css"), "utf8");
const tokensCss = readFileSync(join(here, "../../../../../../packages/ui/src/tokens.css"), "utf8");
const themesCss = readFileSync(join(here, "../../../../../../packages/ui/src/themes.css"), "utf8");

const withoutComments = (css: string): string => css.replace(/\/\*[\s\S]*?\*\//g, "");

function room(): number {
  const rule = /(?:^|\n)\.isl\s*\{([^}]*)\}/.exec(withoutComments(islandCss))?.[1] ?? "";
  const padding = /padding:\s*(\d+)px;/.exec(rule)?.[1];
  if (!padding) {
    throw new Error(".isl has no padding in px");
  }
  return Number(padding);
}

/** Splits a shadow list at the commas between layers, not inside functions. */
function layers(value: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  for (const char of value) {
    if (char === "(") depth += 1;
    if (char === ")") depth -= 1;
    if (char === "," && depth === 0) {
      parts.push(current.trim());
      current = "";
    } else {
      current += char;
    }
  }
  parts.push(current.trim());
  return parts.filter((part) => part !== "");
}

/** How far one outer shadow layer reaches past the edge of its box. */
function reach(layer: string): number {
  if (/\binset\b/.test(layer) || layer === "none") {
    return 0;
  }
  // Lengths outside colour functions: x, y, blur, spread.
  const lengths = layer
    .replace(/[\w-]+\([^()]*(\([^()]*\)[^()]*)*\)/g, " ")
    .split(/\s+/)
    .filter((token) => /^-?\d+(\.\d+)?(px)?$/.test(token))
    .map((token) => Number.parseFloat(token));
  const [x = 0, y = 0, blur = 0, spread = 0] = lengths;
  return Math.max(Math.abs(x), Math.abs(y)) + blur + Math.max(spread, 0);
}

const drops = [tokensCss, themesCss, islandCss].flatMap((css) =>
  [...withoutComments(css).matchAll(/--island-drop:\s*([^;]+);/g)].map((match) => match[1] ?? ""),
);

const shadows = [...withoutComments(islandCss).matchAll(/box-shadow:\s*([^;]+);/g)].map(
  (match) => (match[1] ?? "").replace(/\s+/g, " "),
);

describe("island shadows", () => {
  const limit = room();

  it("finds the shadows it checks", () => {
    expect(drops.length).toBeGreaterThan(3);
    expect(shadows.length).toBeGreaterThan(10);
  });

  it.each(drops)("the theme drop %s fits the window's room", (drop) => {
    for (const layer of layers(drop)) {
      expect(reach(layer), layer).toBeLessThanOrEqual(limit);
    }
  });

  it.each(shadows)("%s fits the window's room", (shadow) => {
    for (const layer of layers(shadow)) {
      if (layer === "var(--island-drop)") {
        continue; // checked for every theme above
      }
      expect(reach(layer), layer).toBeLessThanOrEqual(limit);
    }
  });
});
