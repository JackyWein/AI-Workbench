import { z } from "zod";

export const usageUnitSchema = z.enum([
  "percent",
  "tokens",
  "requests",
  "credits",
  /** An amount of money in US dollars, e.g. a cost the tool computed. */
  "usd",
  "time",
]);
export type UsageUnit = z.infer<typeof usageUnitSchema>;

export const usageLimitSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  used: z.number().nonnegative().optional(),
  remaining: z.number().nonnegative().optional(),
  total: z.number().nonnegative().optional(),
  unit: usageUnitSchema,
  resetsAt: z.date().optional(),
  /**
   * The reset time exactly as the provider wrote it, kept when it could not be
   * turned into a date without guessing.
   */
  resetsText: z.string().optional(),
  /** Length of the window this limit counts over, when the provider says. */
  windowMinutes: z.number().int().positive().optional(),
  /** A local projection from reported samples, never a provider limit. */
  forecast: z.object({
    exhaustsAt: z.date(),
    sampledAt: z.date(),
    samples: z.number().int().min(3),
    observationMinutes: z.number().positive(),
  }).optional(),
});
export type UsageLimit = z.infer<typeof usageLimitSchema>;

/** Where a usage number came from. Never fabricate this (spec §56). */
export const usageSourceSchema = z.enum(["provider", "cli", "api", "estimated"]);
export type UsageSource = z.infer<typeof usageSourceSchema>;

/**
 * Truthfulness state of a snapshot:
 * - available   every advertised limit is known
 * - partial     some limits are known, others are not
 * - unavailable nothing is known; the UI must say "Usage unavailable"
 * - estimated   derived locally and must be labelled as an estimate
 */
export const usageStateSchema = z.enum([
  "available",
  "partial",
  "unavailable",
  "estimated",
]);
export type UsageState = z.infer<typeof usageStateSchema>;

export const providerUsageSnapshotSchema = z.object({
  providerId: z.string().min(1),
  modelId: z.string().min(1).optional(),
  state: usageStateSchema,
  limits: z.array(usageLimitSchema),
  updatedAt: z.date(),
  source: usageSourceSchema,
  /** Why usage is unavailable, when it is. Shown verbatim, never invented. */
  note: z.string().optional(),
  /** The plan the limits belong to, as the provider names it. */
  plan: z.string().optional(),
});
export type ProviderUsageSnapshot = z.infer<typeof providerUsageSnapshotSchema>;

export const aggregatedUsageSchema = z.object({
  snapshots: z.array(providerUsageSnapshotSchema),
  updatedAt: z.date(),
});
export type AggregatedUsage = z.infer<typeof aggregatedUsageSchema>;
