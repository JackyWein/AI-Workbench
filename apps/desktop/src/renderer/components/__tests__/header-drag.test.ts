import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/*
 * Regression: the Chat/Agents toggle lives inside the session header's left
 * side, and the header is a frameless-window drag region
 * (`-webkit-app-region: drag`). Any interactive descendant that does not opt
 * out with `no-drag` has its clicks swallowed as a window drag — the toggle
 * looked fine but could not be switched, while dragging from it moved the
 * window. This pins the CSS contract: the header stays draggable, its
 * actions side stays non-draggable, and the toggle plus every interactive
 * descendant in the draggable side opts out.
 */

const here = import.meta.dirname;
const appCss = readFileSync(join(here, "..", "..", "app.css"), "utf8");

const withoutComments = (css: string): string => css.replace(/\/\*[\s\S]*?\*\//g, "");

/** All declaration blocks for selectors matching exactly `selector`. */
function blocksFor(selector: string): string[] {
  const css = withoutComments(appCss);
  const found: string[] = [];
  const rulePattern = /([^{}]+)\{([^}]*)\}/g;
  let match: RegExpExecArray | null;
  while ((match = rulePattern.exec(css)) !== null) {
    const selectors = (match[1] ?? "").split(",").map((part) => part.trim());
    if (selectors.includes(selector)) {
      found.push(match[2] ?? "");
    }
  }
  return found;
}

function appRegion(blocks: string[]): string | null {
  for (const block of blocks) {
    const value = /-webkit-app-region\s*:\s*([^;]+);/.exec(block)?.[1]?.trim();
    if (value) {
      return value;
    }
  }
  return null;
}

describe("header drag/click contract", () => {
  it("keeps the header itself draggable", () => {
    expect(appRegion(blocksFor(".header"))).toBe("drag");
  });

  it("keeps the header actions out of the drag region", () => {
    expect(appRegion(blocksFor(".header__actions"))).toBe("no-drag");
  });

  it("keeps the Chat/Agents toggle out of the drag region", () => {
    expect(appRegion(blocksFor(".header__main .mode-toggle"))).toBe("no-drag");
  });

  it.each([".header__main button", ".header__main select", ".header__main input", ".header__main a"])(
    "keeps %s clickable inside the draggable header side",
    (selector) => {
      expect(appRegion(blocksFor(selector)), selector).toBe("no-drag");
    },
  );

  it("finds the rules it checks", () => {
    expect(blocksFor(".header").length).toBeGreaterThan(0);
    expect(blocksFor(".header__main .mode-toggle").length).toBeGreaterThan(0);
    expect(blocksFor(".header__main button").length).toBeGreaterThan(0);
  });
});
