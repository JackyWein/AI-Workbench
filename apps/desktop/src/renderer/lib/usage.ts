import { useEffect, useState } from "react";
import type {
  AggregatedUsage,
  ProviderSummary,
  ProviderUsageSnapshot,
  UsageLimit,
} from "@ai-workbench/shared";
import { compactNumber, formatUsd } from "./format.js";

/** How much of a limit is used, 0–100, or null when the tool did not say. */
export function usedPercent(limit: UsageLimit): number | null {
  if (limit.unit === "percent") {
    if (limit.used !== undefined) {
      return clamp(limit.used);
    }
    return limit.remaining === undefined ? null : clamp(100 - limit.remaining);
  }
  if (limit.total === undefined || limit.total <= 0) {
    return null;
  }
  const used = limit.used ?? (limit.remaining === undefined ? undefined : limit.total - limit.remaining);
  return used === undefined ? null : clamp((used / limit.total) * 100);
}

/**
 * True once a window's reset time has passed. The number shown belongs to the
 * old window; the tool has not reported the new one yet, so the UI says that
 * instead of presenting a stale percentage as current.
 */
export function hasReset(limit: UsageLimit, now: number): boolean {
  return limit.resetsAt !== undefined && limit.resetsAt.getTime() <= now;
}

/** The amount a consumption figure reads as, e.g. "41.2m tokens" or "$9.02". */
export function amountOf(limit: UsageLimit): string | null {
  if (limit.used === undefined) {
    return null;
  }
  switch (limit.unit) {
    case "tokens":
      return `${compactNumber(limit.used)} tokens`;
    case "usd":
      return formatUsd(limit.used);
    case "requests":
      return `${compactNumber(limit.used)} requests`;
    case "credits":
      return `${compactNumber(limit.used)} credits`;
    default:
      return null;
  }
}

/** Tone of a meter: calm, getting close, or exhausted. */
export function meterTone(percentUsed: number): "calm" | "warn" | "full" {
  if (percentUsed >= 100) {
    return "full";
  }
  return percentUsed >= 80 ? "warn" : "calm";
}

/** "in 2h 13m", "in 4d 3h", "in 40s" — the time until a reset. */
export function formatIn(target: Date, now: number): string {
  const ms = target.getTime() - now;
  if (ms <= 0) {
    return "now";
  }
  return `in ${formatSpan(ms)}`;
}

/** A span of time at the two coarsest units that matter: "2h 13m". */
export function formatSpan(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days > 0) {
    return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
  }
  if (hours > 0) {
    return `${hours}h ${String(minutes).padStart(2, "0")}m`;
  }
  if (minutes > 0) {
    return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
  }
  return `${seconds}s`;
}

/** A running clock: "4:12", "1:04:09". */
export function formatClock(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = String(seconds % 60).padStart(2, "0");
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, "0")}:${rest}` : `${minutes}:${rest}`;
}

/** "just now", "3 min ago", "2 h ago", "Sep 21". */
export function formatAge(at: Date, now: number): string {
  const seconds = Math.round((now - at.getTime()) / 1000);
  if (seconds < 45) {
    return "just now";
  }
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) {
    return `${minutes} min ago`;
  }
  const hours = Math.round(minutes / 60);
  if (hours < 24) {
    return `${hours} h ago`;
  }
  return at.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/** A wall-clock time for a reset, e.g. "Thu 12:00" or "14:30" today. */
export function formatWhen(at: Date, now: number): string {
  const sameDay = new Date(now).toDateString() === at.toDateString();
  return at.toLocaleString(undefined, {
    ...(sameDay ? {} : { weekday: "short" }),
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** Re-renders every `intervalMs` so clocks and countdowns stay current. */
export function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}

/** The snapshot of a provider, or null when the provider reported none. */
export function snapshotOf(
  usage: AggregatedUsage | null,
  providerId: string,
): ProviderUsageSnapshot | null {
  return usage?.snapshots.find((snapshot) => snapshot.providerId === providerId) ?? null;
}

export interface TightestLimit {
  readonly providerId: string;
  readonly limit: UsageLimit;
  readonly percentUsed: number;
}

/**
 * The quota closest to running out across the given providers, ignoring
 * windows that have reset since they were reported. Null when no provider
 * reported a quota — the UI then shows nothing rather than a guess.
 */
export function tightestLimit(
  usage: AggregatedUsage | null,
  providerIds: ReadonlySet<string>,
  now: number,
): TightestLimit | null {
  let best: TightestLimit | null = null;
  for (const snapshot of usage?.snapshots ?? []) {
    if (!providerIds.has(snapshot.providerId) || snapshot.state === "unavailable") {
      continue;
    }
    for (const limit of snapshot.limits) {
      const percentUsed = usedPercent(limit);
      if (percentUsed === null || hasReset(limit, now)) {
        continue;
      }
      if (!best || percentUsed > best.percentUsed) {
        best = { providerId: snapshot.providerId, limit, percentUsed };
      }
    }
  }
  return best;
}

/**
 * Every account the Usage screen lists: installed and switched on, whether or
 * not its tool reports usage — one that does not is shown as such rather
 * than left out. The simulated provider only appears in developer mode.
 */
export function usageAccounts(
  providers: readonly ProviderSummary[],
  developerMode: boolean,
): Array<{ readonly provider: ProviderSummary; readonly reports: boolean }> {
  return providers
    .filter(
      (provider) =>
        provider.enabled &&
        provider.installation.state === "installed" &&
        (developerMode || provider.metadata.transportTypes.some((type) => type !== "in-process")),
    )
    .map((provider) => ({ provider, reports: provider.capabilities.supported.includes("usage") }));
}

/** Where a snapshot's numbers came from, in words. */
export function usageSourceLabel(source: ProviderUsageSnapshot["source"]): string {
  switch (source) {
    case "provider":
      return "Reported by the tool";
    case "cli":
      return "Read from the tool's command";
    case "api":
      return "From the provider's service";
    case "estimated":
      return "Estimated";
  }
}

/**
 * Providers whose usage is worth showing: installed, visible, and able to
 * report usage. The simulated provider only appears in developer mode.
 */
export function usageProviders(
  providers: readonly ProviderSummary[],
  developerMode: boolean,
): ProviderSummary[] {
  return providers.filter(
    (provider) =>
      provider.enabled &&
      provider.installation.state === "installed" &&
      provider.capabilities.supported.includes("usage") &&
      (developerMode || provider.metadata.transportTypes.some((type) => type !== "in-process")),
  );
}

function clamp(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)));
}
