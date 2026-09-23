import { describe, expect, it } from "vitest";
import { anchorResize, metricsLine } from "../island-helpers.js";

const pill = { x: 800, y: 6, width: 240, height: 62 };
const card = { width: 364, height: 430 };

describe("island resize anchoring", () => {
  it("opens a top-docked pill in place, centered on its rail", () => {
    expect(anchorResize(pill, card, "top")).toEqual({ x: 738, y: 6 });
  });

  it("grows a bottom-docked pill upward", () => {
    expect(anchorResize(pill, card, "bottom")).toEqual({ x: 738, y: 6 + 62 - 430 });
  });

  it("keeps a right-docked pill against its edge", () => {
    expect(anchorResize(pill, card, "right")).toEqual({ x: 800 + 240 - 364, y: 6 - 184 });
  });

  it("keeps a free circle where it is while its card opens beside it", () => {
    const blob = { x: 100, y: 300, width: 66, height: 66 };
    expect(anchorResize(blob, { width: 372, height: 168 }, null)).toEqual({ x: 100, y: 249 });
  });
});

describe("island metrics line", () => {
  it("says only what the tool reported", () => {
    expect(
      metricsLine({
        source: "statusLine",
        tokens: { input: 20_000, output: 900, cacheRead: 14_000 },
        context: { usedTokens: 34_000, windowTokens: 200_000 },
        costUsd: 0.036,
        model: "Haiku 4.5",
        limits: [],
        updatedAt: new Date(),
      }),
    ).toBe("34.9k tokens · ctx 17% · ≈$0.036 · Haiku 4.5");
  });

  it("is empty when nothing was reported", () => {
    expect(metricsLine({ source: "statusLine", limits: [], updatedAt: new Date() })).toBe("");
  });
});
