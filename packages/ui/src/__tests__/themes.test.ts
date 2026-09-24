import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/*
 * Every theme is only a set of token values, so whether it is readable can be
 * decided from the stylesheets alone: resolve each theme's tokens the way the
 * cascade does and measure text against the ground it is set on (WCAG 2
 * contrast). A new theme, or a tweak to one, cannot make text unreadable
 * without this failing.
 */

const source = join(import.meta.dirname, "..");
const tokensCss = readFileSync(join(source, "tokens.css"), "utf8");
const themesCss = readFileSync(join(source, "themes.css"), "utf8");

interface Rule {
  readonly selectors: readonly string[];
  readonly declarations: ReadonlyMap<string, string>;
}

function parse(css: string): Rule[] {
  const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, "").replace(/@import[^;]*;/g, "");
  const rules: Rule[] = [];
  const pattern = /([^{}]+)\{([^{}]*)\}/g;
  for (const match of withoutComments.matchAll(pattern)) {
    const selectors = (match[1] ?? "")
      .split(",")
      .map((selector) => selector.trim())
      .filter((selector) => selector !== "");
    const declarations = new Map<string, string>();
    for (const declaration of (match[2] ?? "").split(/;(?![^(]*\))/)) {
      const colon = declaration.indexOf(":");
      if (colon === -1) {
        continue;
      }
      const name = declaration.slice(0, colon).trim();
      if (name.startsWith("--")) {
        declarations.set(name, declaration.slice(colon + 1).trim().replace(/\s+/g, " "));
      }
    }
    rules.push({ selectors, declarations });
  }
  return rules;
}

// Only plain rules take part; @media and @font-face blocks are skipped by
// the selector test below, which accepts nothing but theme selectors.
const rules = [...parse(tokensCss), ...parse(themesCss)];

function applies(selector: string, theme: string): boolean {
  if (selector === ":root" || selector === "[data-theme]") {
    return true;
  }
  if (selector === `[data-theme="${theme}"]`) {
    return true;
  }
  // `|=` matches the value itself or the value followed by a hyphen.
  const family = /^\[data-theme\|="([\w-]+)"\]$/.exec(selector)?.[1];
  return family !== undefined && (theme === family || theme.startsWith(`${family}-`));
}

function tokensOf(theme: string): Map<string, string> {
  const tokens = new Map<string, string>();
  for (const rule of rules) {
    if (rule.selectors.some((selector) => applies(selector, theme))) {
      for (const [name, value] of rule.declarations) {
        tokens.set(name, value);
      }
    }
  }
  return tokens;
}

function resolve(tokens: ReadonlyMap<string, string>, name: string, depth = 0): string {
  const value = tokens.get(name);
  if (value === undefined) {
    throw new Error(`${name} is not defined`);
  }
  if (depth > 10) {
    throw new Error(`${name} refers to itself`);
  }
  const reference = /^var\((--[\w-]+)\)$/.exec(value);
  return reference?.[1] ? resolve(tokens, reference[1], depth + 1) : value;
}

type Rgba = readonly [number, number, number, number];

function color(value: string): Rgba {
  const hex = /^#([0-9a-f]{6})$/i.exec(value);
  if (hex?.[1]) {
    const n = Number.parseInt(hex[1], 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255, 1];
  }
  const rgba = /^rgba?\(([^)]+)\)$/.exec(value);
  if (rgba?.[1]) {
    const [r = 0, g = 0, b = 0, a = 1] = rgba[1].split(",").map((part) => Number(part.trim()));
    return [r, g, b, a];
  }
  throw new Error(`not a colour: ${value}`);
}

/** A translucent colour as it appears over an opaque one. */
function over(top: Rgba, bottom: Rgba): Rgba {
  const a = top[3];
  return [
    top[0] * a + bottom[0] * (1 - a),
    top[1] * a + bottom[1] * (1 - a),
    top[2] * a + bottom[2] * (1 - a),
    1,
  ];
}

function luminance([r, g, b]: Rgba): number {
  const channel = (value: number): number => {
    const s = value / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function contrast(a: Rgba, b: Rgba): number {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (light + 0.05) / (dark + 0.05);
}

/** Quiet's two modes, then every other theme in both of its modes. */
const families = [
  ...new Set([...themesCss.matchAll(/\[data-theme\|="([\w-]+)"\]/g)].map((match) => match[1] ?? "")),
];
const themes = ["dark", "light", ...families.flatMap((family) => [`${family}-light`, `${family}-dark`])];

/**
 * Text and the ground it sits on, with the least contrast allowed. Body text
 * gets WCAG AA (4.5); muted captions and coloured status words get the
 * large-text/UI floor (3.0), which Quiet has always met.
 */
const pairs: ReadonlyArray<readonly [string, string, number, string?]> = [
  ["--text-primary", "--surface-base", 7],
  ["--text-primary", "--surface-raised", 7],
  ["--text-primary", "--surface-message", 7, "--surface-base"],
  ["--text-secondary", "--surface-base", 4.5],
  ["--text-secondary", "--surface-raised", 4.5],
  ["--text-muted", "--surface-base", 3.5],
  ["--text-muted", "--surface-raised", 3.5],
  ["--accent-text", "--surface-base", 4.5],
  ["--accent-contrast", "--accent", 4.5],
  ["--success", "--surface-base", 3],
  ["--warning", "--surface-base", 3],
  ["--danger", "--surface-base", 3],
  ["--running", "--surface-base", 3],
  ["--code-text", "--code-surface", 7],
  ["--code-label", "--code-surface", 4.5],
  ["--sidebar-text", "--sidebar-surface", 7, "--surface-base"],
  ["--sidebar-text-secondary", "--sidebar-surface", 4.5, "--surface-base"],
  ["--sidebar-text-muted", "--sidebar-surface", 3.5, "--surface-base"],
  ["--island-text", "--island-body", 7],
  ["--island-text", "--island-surface", 7],
  ["--island-text-secondary", "--island-body", 4.5],
  ["--island-text-muted", "--island-body", 3.5],
  ["--island-on-warning", "--island-warning", 4.5],
  ["--island-on-accent", "--island-accent", 4.5],
  ["--island-running", "--island-body", 4.5],
  ["--island-warning", "--island-body", 4.5],
  ["--terminal-text", "--terminal-surface", 7],
];

const ansi = ["red", "green", "yellow", "blue", "magenta", "cyan"].flatMap((name) => [
  `--term-${name}`,
  `--term-bright-${name}`,
]);

describe("themes", () => {
  it("offers the house theme and five others, each light and dark", () => {
    expect(families).toEqual(["atelier", "mission", "playground", "aurora", "swiss"]);
    for (const family of families) {
      for (const mode of ["light", "dark"]) {
        expect(themesCss, `${family} has its ${mode} mode`).toMatch(
          new RegExp(`\\[data-theme\\|?="${family}(-${mode})?"\\][^{]*\\{[^}]*color-scheme: ${mode}`),
        );
      }
    }
  });

  for (const theme of themes) {
    describe(theme, () => {
      const tokens = tokensOf(theme);
      // The island floats over a desktop the app knows nothing about; its
      // grounds are measured over black, the worst case for a dark body.
      const desktop: Rgba = [0, 0, 0, 1];

      for (const [text, ground, minimum, beneath] of pairs) {
        it(`${text} reads on ${ground}`, () => {
          const base = beneath
            ? color(resolve(tokens, beneath))
            : text.startsWith("--island")
              ? desktop
              : color(resolve(tokens, "--surface-base"));
          const background = over(color(resolve(tokens, ground)), base);
          const foreground = over(color(resolve(tokens, text)), background);
          expect(contrast(foreground, background)).toBeGreaterThanOrEqual(minimum);
        });
      }

      it("keeps every terminal colour readable", () => {
        const background = color(resolve(tokens, "--terminal-surface"));
        for (const name of ansi) {
          expect(
            contrast(color(resolve(tokens, name)), background),
            `${name} on the terminal`,
          ).toBeGreaterThanOrEqual(3);
        }
      });
    });
  }
});
