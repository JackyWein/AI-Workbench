import { describe, expect, it } from "vitest";
import {
  anchorResize,
  dockPoint,
  dragFrame,
  metricsLine,
  railOf,
  settleEase,
  snapEdge,
} from "../island-helpers.js";

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

const area = { x: 0, y: 0, width: 1920, height: 1040 };
const pillWindow = { width: 296, height: 62 };

describe("island rails", () => {
  it("docks a pill centered on its spot with an even gap to the edge", () => {
    // The painted pill sits 8px from the edge; the window's 12px padding hangs past it.
    expect(dockPoint("top", 500, pillWindow, area)).toEqual({ x: 352, y: -4 });
    expect(dockPoint("bottom", null, pillWindow, area)).toEqual({ x: 812, y: 982 });
  });

  it("lets a pill ride all the way into a corner, but not past it", () => {
    expect(dockPoint("top", 0, pillWindow, area)).toEqual({ x: -4, y: -4 });
    expect(dockPoint("right", 5000, { width: 62, height: 142 }, area)).toEqual({ x: 1862, y: 902 });
  });

  it("stores a spot that docks back to the same place", () => {
    const at = dockPoint("left", 300, { width: 62, height: 142 }, area);
    expect(railOf("left", { ...at, width: 62, height: 142 }, area)).toBe(300);
  });

  it("settles with a small overshoot and lands exactly", () => {
    expect(settleEase(0)).toBeCloseTo(0);
    expect(settleEase(1)).toBe(1);
    expect(Math.max(...[0.6, 0.7, 0.8, 0.9].map(settleEase))).toBeGreaterThan(1);
  });
});

describe("island drag", () => {
  const grab = { x: 0.5, y: 0.5 };

  it("slides a docked pill along its rail under the pointer", () => {
    const frame = dragFrame({
      pointer: { x: 700, y: 30 },
      grab,
      size: pillWindow,
      area,
      edge: "top",
      depth: 30,
    });
    expect(frame).toMatchObject({ edge: "top", x: 552, y: -4, regrab: false });
  });

  it("gives a little when pulled, then lets go past the detach distance", () => {
    const held = dragFrame({ pointer: { x: 700, y: 90 }, grab, size: pillWindow, area, edge: "top", depth: 30 });
    expect(held.edge).toBe("top");
    expect(held.y).toBe(14);
    const free = dragFrame({ pointer: { x: 700, y: 140 }, grab, size: pillWindow, area, edge: "top", depth: 30 });
    expect(free).toMatchObject({ edge: null, regrab: true });
  });

  it("turns the corner onto the next rail", () => {
    const frame = dragFrame({
      pointer: { x: 1905, y: 300 },
      grab,
      size: pillWindow,
      area,
      edge: "top",
      depth: 30,
    });
    expect(frame).toMatchObject({ edge: "right", regrab: true });
  });

  it("carries a free blob and names the rail it would dock to", () => {
    const blob = { width: 66, height: 66 };
    const middle = dragFrame({ pointer: { x: 900, y: 500 }, grab, size: blob, area, edge: null, depth: 0 });
    expect(middle).toMatchObject({ edge: null, snap: null, x: 867, y: 467 });
    const nearTop = dragFrame({ pointer: { x: 900, y: 60 }, grab, size: blob, area, edge: null, depth: 0 });
    expect(nearTop.snap).toBe("top");
  });

  it("finds no rail for a blob in open space", () => {
    expect(snapEdge({ x: 400, y: 400 }, { width: 66, height: 66 }, area)).toBeNull();
    expect(snapEdge({ x: 1880, y: 400 }, { width: 66, height: 66 }, area)).toBe("right");
  });
});
