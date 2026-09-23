import { ISLAND_TIMING, type IslandEdge, type TerminalMetrics } from "@ai-workbench/shared";

/**
 * Pure helpers for the island's window and lines, kept apart from Electron so
 * they can be tested on their own.
 */

/**
 * Where a resized island keeps its footing. A docked pill grows away from its
 * edge and stays centered along it, so it opens in place into its card; a
 * free blob keeps its left side and vertical center, so the circle stays put
 * while a card opens beside it.
 */
export function anchorResize(
  bounds: { x: number; y: number; width: number; height: number },
  size: { width: number; height: number },
  edge: IslandEdge | null,
): { x: number; y: number } {
  const centerX = bounds.x + Math.round((bounds.width - size.width) / 2);
  const centerY = bounds.y + Math.round((bounds.height - size.height) / 2);
  switch (edge) {
    case "top":
      return { x: centerX, y: bounds.y };
    case "bottom":
      return { x: centerX, y: bounds.y + bounds.height - size.height };
    case "left":
      return { x: bounds.x, y: centerY };
    case "right":
      return { x: bounds.x + bounds.width - size.width, y: centerY };
    case null:
      return { x: bounds.x, y: centerY };
  }
}

export interface Point {
  readonly x: number;
  readonly y: number;
}

export interface Size {
  readonly width: number;
  readonly height: number;
}

export interface Rect extends Point, Size {}

/** Transparent room the page keeps around the unit for its glow and badge. */
export const ISLAND_PAD = 12;
/** Visible gap between a docked pill and its screen edge. */
export const RAIL_GAP = 8;
/** How much of a pull off the rail the pill follows before it lets go. */
const RUBBER = 0.3;
/** A nearer rail must win by this much before the pill changes rails. */
const RAIL_STICK = 18;

const EDGES: readonly IslandEdge[] = ["top", "right", "bottom", "left"];

export function isVertical(edge: IslandEdge): boolean {
  return edge === "left" || edge === "right";
}

function clamp(value: number, low: number, high: number): number {
  return high < low ? low : Math.min(Math.max(value, low), high);
}

/** How far a point is inside the area from each of its edges. */
export function edgeDistances(point: Point, area: Rect): Record<IslandEdge, number> {
  return {
    top: point.y - area.y,
    bottom: area.y + area.height - point.y,
    left: point.x - area.x,
    right: area.x + area.width - point.x,
  };
}

/**
 * Where a window of this size sits docked on a rail. The pill's center rides
 * `along` pixels from the rail's start (null centers it) and can travel the
 * whole edge, corner to corner; the window's transparent padding may hang
 * past the edge so the painted pill keeps an even gap to it.
 */
export function dockPoint(
  edge: IslandEdge,
  along: number | null,
  size: Size,
  area: Rect,
  pull = 0,
): Point {
  const inset = RAIL_GAP - ISLAND_PAD;
  if (isVertical(edge)) {
    const center = along === null ? area.height / 2 : along;
    const y = clamp(
      area.y + center - size.height / 2,
      area.y + inset,
      area.y + area.height - inset - size.height,
    );
    const x =
      edge === "left"
        ? area.x + inset + pull
        : area.x + area.width - inset - size.width - pull;
    return { x: Math.round(x), y: Math.round(y) };
  }
  const center = along === null ? area.width / 2 : along;
  const x = clamp(
    area.x + center - size.width / 2,
    area.x + inset,
    area.x + area.width - inset - size.width,
  );
  const y =
    edge === "top" ? area.y + inset + pull : area.y + area.height - inset - size.height - pull;
  return { x: Math.round(x), y: Math.round(y) };
}

/** The along-rail spot of a window's center, as stored in `railT`. */
export function railOf(edge: IslandEdge, bounds: Rect, area: Rect): number {
  return Math.round(
    isVertical(edge)
      ? bounds.y + bounds.height / 2 - area.y
      : bounds.x + bounds.width / 2 - area.x,
  );
}

/** Keeps a free window on the area; only its transparent padding may hang off. */
export function clampFree(point: Point, size: Size, area: Rect): Point {
  return {
    x: Math.round(
      clamp(point.x, area.x - ISLAND_PAD, area.x + area.width + ISLAND_PAD - size.width),
    ),
    y: Math.round(
      clamp(point.y, area.y - ISLAND_PAD, area.y + area.height + ISLAND_PAD - size.height),
    ),
  };
}

export interface DragInput {
  /** Pointer on screen. */
  readonly pointer: Point;
  /** Where the unit is held, as a fraction of the window (0..1 each way). */
  readonly grab: Point;
  /** Current window size. */
  readonly size: Size;
  /** Work area of the display under the pointer. */
  readonly area: Rect;
  /** The rail the pill rides, or null for a free blob. */
  readonly edge: IslandEdge | null;
  /** How deep into the rail the pointer held the pill when it got there. */
  readonly depth: number;
}

export interface DragFrame extends Point {
  readonly edge: IslandEdge | null;
  /** The rail a free blob would dock to if released now. */
  readonly snap: IslandEdge | null;
  readonly depth: number;
  /** True when this frame changed rails or left one; grab resets to center. */
  readonly regrab: boolean;
}

/**
 * One frame of a drag. A docked pill slides along its rail under the pointer,
 * turns corners onto the neighbouring rail, and gives a little when pulled
 * away before letting go past `detachPx`, from where it is a free blob. A free
 * blob follows the pointer and reports the rail it would dock to on release.
 */
export function dragFrame(input: DragInput): DragFrame {
  const { pointer, grab, size, area } = input;
  const distance = edgeDistances(pointer, area);

  if (input.edge !== null) {
    let edge = input.edge;
    for (const candidate of EDGES) {
      if (distance[candidate] < distance[edge] - RAIL_STICK) {
        edge = candidate;
      }
    }
    const turned = edge !== input.edge;
    const thickness = (isVertical(edge) ? size.width : size.height) - ISLAND_PAD * 2;
    const depth = turned ? RAIL_GAP + Math.max(0, thickness) / 2 : input.depth;
    const pull = Math.max(0, distance[edge] - depth);
    if (pull <= ISLAND_TIMING.detachPx) {
      const hold = turned ? 0.5 : isVertical(edge) ? grab.y : grab.x;
      const along = isVertical(edge)
        ? pointer.y - area.y - (hold - 0.5) * size.height
        : pointer.x - area.x - (hold - 0.5) * size.width;
      const point = dockPoint(edge, along, size, area, pull * RUBBER);
      return { ...point, edge, snap: null, depth, regrab: turned };
    }
    // Pulled clear: a free blob from here, centered under the pointer.
    const free = clampFree(
      { x: pointer.x - size.width / 2, y: pointer.y - size.height / 2 },
      size,
      area,
    );
    return { ...free, edge: null, snap: snapEdge(free, size, area), depth: 0, regrab: true };
  }

  const free = clampFree(
    { x: pointer.x - grab.x * size.width, y: pointer.y - grab.y * size.height },
    size,
    area,
  );
  return { ...free, edge: null, snap: snapEdge(free, size, area), depth: 0, regrab: false };
}

/** The rail a free unit is within `snapPx` of, nearest first; null when none. */
export function snapEdge(position: Point, size: Size, area: Rect): IslandEdge | null {
  const unit = {
    left: position.x + ISLAND_PAD,
    top: position.y + ISLAND_PAD,
    right: position.x + size.width - ISLAND_PAD,
    bottom: position.y + size.height - ISLAND_PAD,
  };
  const gaps: Record<IslandEdge, number> = {
    top: unit.top - area.y,
    bottom: area.y + area.height - unit.bottom,
    left: unit.left - area.x,
    right: area.x + area.width - unit.right,
  };
  let best: IslandEdge | null = null;
  for (const edge of EDGES) {
    if (gaps[edge] <= ISLAND_TIMING.snapPx && (best === null || gaps[edge] < gaps[best])) {
      best = edge;
    }
  }
  return best;
}

/** Springy ease with a small overshoot, for settling onto a rail. */
export function settleEase(t: number): number {
  const c1 = 1.1;
  const c3 = c1 + 1;
  const u = t - 1;
  return 1 + c3 * u * u * u + c1 * u * u;
}

/** Compact counts for one island line: 1.2k, 3.4m. */
function compact(value: number): string {
  if (value >= 1_000_000) {
    return `${(value / 1_000_000).toFixed(1)}m`;
  }
  if (value >= 1_000) {
    return `${(value / 1_000).toFixed(1)}k`;
  }
  return String(Math.round(value));
}

/**
 * What a terminal agent reported so far, in one line: tokens, context fill
 * and cost, each only when the tool said so. Empty when it said nothing.
 */
export function metricsLine(metrics: TerminalMetrics): string {
  const parts: string[] = [];
  const tokens = metrics.tokens;
  if (tokens) {
    const total = tokens.input + tokens.output + (tokens.cacheRead ?? 0) + (tokens.cacheWrite ?? 0);
    if (total > 0) {
      parts.push(`${compact(total)} tokens`);
    }
  }
  const context = metrics.context;
  if (context?.windowTokens && context.windowTokens > 0) {
    parts.push(`ctx ${Math.min(100, Math.round((context.usedTokens / context.windowTokens) * 100))}%`);
  }
  if (metrics.costUsd !== undefined && metrics.costUsd > 0) {
    parts.push(`≈$${metrics.costUsd < 1 ? metrics.costUsd.toFixed(3) : metrics.costUsd.toFixed(2)}`);
  }
  if (metrics.model) {
    parts.push(metrics.model);
  }
  return parts.join(" · ");
}
