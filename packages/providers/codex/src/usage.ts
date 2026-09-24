import type { ProviderUsageSnapshot, UsageLimit } from "@ai-workbench/shared";
import type { RateLimitSnapshot, RateLimitWindow, RateLimitsResponse } from "./app-server.js";
import { formatPlan } from "./auth.js";

/**
 * Maps `account/rateLimits/read` onto a usage snapshot (spec §55, §56).
 *
 * Codex meters an account in buckets ("codex" today), each with a short and a
 * long window. Every number here is the tool's own: the percentage used, the
 * window length and the reset time. Nothing is derived beyond "remaining is
 * what is not used", which holds for a percentage by definition.
 */
export function toUsageSnapshot(
  response: RateLimitsResponse,
  providerId: string,
  now: Date = new Date(),
): ProviderUsageSnapshot {
  const buckets = bucketsOf(response);
  const labelBuckets = buckets.length > 1;
  const limits: UsageLimit[] = [];

  for (const [key, bucket] of buckets) {
    const prefix = labelBuckets ? `${bucket.limitName?.trim() || key} · ` : "";
    for (const slot of ["primary", "secondary"] as const) {
      const window = bucket[slot];
      if (window) {
        limits.push(toLimit(`${key}.${slot}`, prefix, slot, window));
      }
    }
  }

  const plan = formatPlan(buckets.find(([, bucket]) => bucket.planType)?.[1].planType);
  const base = {
    providerId,
    updatedAt: now,
    source: "cli" as const,
    ...(plan === undefined ? {} : { plan }),
  };

  if (limits.length === 0) {
    return {
      ...base,
      state: "unavailable",
      limits: [],
      note: "Codex reported no usage limits for this account.",
    };
  }

  const note = limitReachedNote(response, buckets, limits);
  return { ...base, state: "available", limits, ...(note === null ? {} : { note }) };
}

/** The window's name, from its length: Codex has a five hour and a weekly one. */
export function windowLabel(minutes: number | null | undefined, slot: "primary" | "secondary"): string {
  if (minutes === null || minutes === undefined || minutes <= 0) {
    return slot === "primary" ? "Short window" : "Long window";
  }
  if (minutes === 10_080) {
    return "Weekly";
  }
  if (minutes % 1440 === 0) {
    return `${minutes / 1440}-day window`;
  }
  if (minutes % 60 === 0) {
    return `${minutes / 60}-hour window`;
  }
  return `${minutes}-minute window`;
}

/** A reset time as the note shows it, e.g. "Sep 24, 7:42 PM", in local time. */
function formatResetTime(date: Date): string {
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

type Bucket = readonly [key: string, snapshot: RateLimitSnapshot];

function bucketsOf(response: RateLimitsResponse): Bucket[] {
  const byId = Object.entries(response.rateLimitsByLimitId ?? {}).filter(
    (entry): entry is [string, RateLimitSnapshot] => entry[1] !== null && entry[1] !== undefined,
  );
  if (byId.length > 0) {
    return byId.sort(([a], [b]) => a.localeCompare(b));
  }
  const single = response.rateLimits;
  return single ? [[single.limitId?.trim() || "codex", single]] : [];
}

function toLimit(
  id: string,
  prefix: string,
  slot: "primary" | "secondary",
  window: RateLimitWindow,
): UsageLimit {
  const used = Math.round(Math.min(100, Math.max(0, window.usedPercent)) * 10) / 10;
  const minutes =
    window.windowDurationMins !== null &&
    window.windowDurationMins !== undefined &&
    window.windowDurationMins > 0
      ? Math.round(window.windowDurationMins)
      : undefined;
  const resetsAt =
    window.resetsAt !== null && window.resetsAt !== undefined && window.resetsAt > 0
      ? new Date(window.resetsAt * 1000)
      : undefined;

  return {
    id,
    label: `${prefix}${windowLabel(minutes, slot)}`,
    used,
    remaining: Math.round((100 - used) * 10) / 10,
    total: 100,
    unit: "percent",
    ...(resetsAt === undefined ? {} : { resetsAt }),
    ...(minutes === undefined ? {} : { windowMinutes: minutes }),
  };
}

/**
 * Says so when the account cannot be used right now. The reset shown is the
 * latest one among the exhausted windows, because usage only resumes once all
 * of them have reset; without an exhausted window no time is claimed.
 */
function limitReachedNote(
  response: RateLimitsResponse,
  buckets: readonly Bucket[],
  limits: readonly UsageLimit[],
): string | null {
  const reachedType = buckets
    .map(([, bucket]) => bucket.rateLimitReachedType?.trim())
    .find((value): value is string => Boolean(value));
  if (response.ordinaryUsageAllowed !== false && reachedType === undefined) {
    return null;
  }

  const reason = reachedReason(reachedType);
  const resets = limits
    .filter((limit) => (limit.used ?? 0) >= 100 && limit.resetsAt !== undefined)
    .map((limit) => limit.resetsAt as Date)
    .sort((a, b) => b.getTime() - a.getTime())[0];
  return resets === undefined ? reason : `${reason} — resets ${formatResetTime(resets)}`;
}

function reachedReason(type: string | undefined): string {
  switch (type) {
    case "workspace_owner_credits_depleted":
    case "workspace_member_credits_depleted":
      return "Workspace credits used up";
    case "workspace_owner_usage_limit_reached":
    case "workspace_member_usage_limit_reached":
      return "Workspace limit reached";
    default:
      return "Limit reached";
  }
}
