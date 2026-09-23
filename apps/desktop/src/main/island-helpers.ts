import type { IslandEdge, TerminalMetrics } from "@ai-workbench/shared";

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
