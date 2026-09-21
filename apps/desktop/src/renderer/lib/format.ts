import type { ProviderUsageSnapshot, UsageLimit } from "@ai-workbench/shared";

/** Percentage of a limit still available, or null when it cannot be known. */
export function remainingPercent(limit: UsageLimit): number | null {
  if (limit.unit === "percent" && limit.remaining !== undefined) {
    return clampPercent(limit.remaining);
  }
  if (limit.total !== undefined && limit.total > 0) {
    const remaining =
      limit.remaining ?? (limit.used === undefined ? undefined : limit.total - limit.used);
    if (remaining !== undefined) {
      return clampPercent((remaining / limit.total) * 100);
    }
  }
  return null;
}

/** The headline number for the compact indicator, or null when unknown. */
export function headlineUsage(
  snapshot: ProviderUsageSnapshot,
): { label: string; percent: number } | null {
  for (const limit of snapshot.limits) {
    const percent = remainingPercent(limit);
    if (percent !== null) {
      return { label: limit.label, percent };
    }
  }
  return null;
}

export function formatRelativeTime(value: Date, now = new Date()): string {
  const seconds = Math.round((now.getTime() - value.getTime()) / 1000);
  if (seconds < 45) {
    return "just now";
  }
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) {
    return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  }
  const hours = Math.round(minutes / 60);
  if (hours < 24) {
    return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  }
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

export function formatPath(path: string, maxLength = 44): string {
  if (path.length <= maxLength) {
    return path;
  }
  return `...${path.slice(path.length - maxLength + 3)}`;
}

function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)));
}
