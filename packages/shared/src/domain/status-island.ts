import { z } from "zod";

/**
 * The Status Island (spec §95–§103).
 *
 * The island is a view onto state the application already has. Nothing here
 * invents a number: a percentage exists only where there are tasks to count,
 * and a solo session gets a named state instead (spec §103).
 */

export const islandWidgetIdSchema = z.enum([
  "needsAttention",
  "agentQuestion",
  "activeAgents",
  "teamProgress",
  "providerUsage",
  "completedWork",
  "errors",
  "connectionHealth",
  "idle",
]);
export type IslandWidgetId = z.infer<typeof islandWidgetIdSchema>;

export const islandPositionSchema = z.enum([
  "topCenter",
  "topLeft",
  "topRight",
  "custom",
]);
export type IslandPosition = z.infer<typeof islandPositionSchema>;

/** Edge-dock rails (Island Apple): null means a free blob. */
export const islandEdgeSchema = z.enum(["top", "right", "bottom", "left"]);
export type IslandEdge = z.infer<typeof islandEdgeSchema>;

export const islandPreferencesSchema = z.object({
  enabled: z.boolean().default(true),
  startWithApp: z.boolean().default(true),
  stayVisibleWhenHidden: z.boolean().default(true),
  alwaysOnTop: z.boolean().default(true),
  autoExpand: z.boolean().default(true),
  position: islandPositionSchema.default("topCenter"),
  /** Only meaningful for the custom position; screen coordinates. */
  customX: z.number().int().nullable().default(null),
  customY: z.number().int().nullable().default(null),
  /** Which display to sit on, by Electron's display id; null is the active one. */
  displayId: z.number().int().nullable().default(null),
  defaultWidget: islandWidgetIdSchema.default("providerUsage"),
  /** Seconds between automatic widget changes; 0 is off. */
  autoRotateSeconds: z.number().int().min(0).max(600).default(0),
  enabledWidgets: z.array(islandWidgetIdSchema).default([
    "needsAttention",
    "activeAgents",
    "teamProgress",
    "providerUsage",
    "completedWork",
    "errors",
    "connectionHealth",
  ]),
  /** A widget the user chose to keep; null means automatic (spec §100). */
  pinnedWidget: islandWidgetIdSchema.nullable().default(null),
  /** Closing the main window quits, or leaves the runtime going (spec §104). */
  closeToTray: z.boolean().default(false),
  /** Edge-dock (Island Apple): the rail the pill sits on, or null for a free blob. */
  dockedEdge: islandEdgeSchema.nullable().default(null),
  /** Position along the rail in pixels; null means centered. */
  railT: z.number().nullable().default(null),
  /** The minimal circle is the default face; false starts expanded. */
  minimalByDefault: z.boolean().default(true),
});
export type IslandPreferences = z.infer<typeof islandPreferencesSchema>;
export const defaultIslandPreferences: IslandPreferences =
  islandPreferencesSchema.parse({});

/** Somewhere in the application an island entry can deep-link to (spec §98). */
export const islandTargetSchema = z.object({
  view: z.enum(["chat", "teams", "providers", "mcp", "settings"]),
  sessionId: z.string().min(1).optional(),
  runId: z.string().min(1).optional(),
});
export type IslandTarget = z.infer<typeof islandTargetSchema>;

/** One diff line in a capped approval preview; the producer caps at 6 lines. */
export const islandDiffLineSchema = z.object({
  kind: z.enum(["add", "del", "ctx"]),
  text: z.string().max(500),
});
export type IslandDiffLine = z.infer<typeof islandDiffLineSchema>;

/** One answerable option on an agent question. */
export const islandOptionSchema = z.object({
  id: z.string().min(1).max(200),
  label: z.string().min(1).max(200),
  hint: z.string().max(200).optional(),
});
export type IslandOption = z.infer<typeof islandOptionSchema>;

/** One provider usage row, from real snapshots only — never estimated. */
export const islandUsageRowSchema = z.object({
  providerId: z.string().min(1),
  name: z.string().min(1).max(120),
  /** Window label from the provider (Weekly, 5-hour, Daily). */
  window: z.string().max(60).default(""),
  /** Percent remaining, or null when the provider did not report a number. */
  percentLeft: z.number().min(0).max(100).nullable(),
});
export type IslandUsageRow = z.infer<typeof islandUsageRowSchema>;

/** One thing the island can show, produced by the attention service. */
export const islandEntrySchema = z.object({
  widget: islandWidgetIdSchema,
  priority: z.number().int().min(0).max(100),
  /** One compact line; the island shows this and nothing else when collapsed. */
  title: z.string(),
  detail: z.string().default(""),
  /** Progress counted from real items, never estimated (spec §103). */
  progress: z
    .object({ completed: z.number().int().nonnegative(), total: z.number().int().positive() })
    .nullable()
    .default(null),
  /** Present when the entry needs a person, which is what may expand it. */
  action: z
    .object({ label: z.string(), target: islandTargetSchema })
    .nullable()
    .default(null),
  /** Identifies the underlying thing, so a repeat does not queue twice. */
  key: z.string(),
  at: z.date(),
  /** Approval diff preview, capped by the producer; absent when not an approval. */
  diff: z
    .object({
      file: z.string().max(500),
      stat: z.string().max(120),
      lines: z.array(islandDiffLineSchema).max(6),
    })
    .nullable()
    .default(null),
  /** Answerable options; absent when the entry is not a question. */
  options: z.array(islandOptionSchema).max(9).default([]),
  /** Provider mark key for the Logo component; absent falls back to a letter. */
  icon: z.string().max(120).nullable().default(null),
  /** Structured usage rows for the usage panel; empty when nothing reported. */
  usage: z.array(islandUsageRowSchema).max(24).default([]),
});
export type IslandEntry = z.infer<typeof islandEntrySchema>;

export const islandStateSchema = z.object({
  /** What the island is showing right now. */
  current: islandEntrySchema,
  /** True while an important entry is overriding the quiet one (spec §97). */
  expanded: z.boolean(),
  /** Everything currently worth showing, highest priority first. */
  entries: z.array(islandEntrySchema),
  preferences: islandPreferencesSchema,
});
export type IslandState = z.infer<typeof islandStateSchema>;

/** Priorities from spec §99, in one place so nothing scatters them. */
export const ISLAND_PRIORITY = {
  userActionRequired: 100,
  agentQuestion: 95,
  permissionRequired: 90,
  agentBlocked: 80,
  connectionFailure: 70,
  workCompleted: 60,
  taskCompleted: 50,
  activeProgress: 40,
  agentActivity: 30,
  providerUsage: 20,
  idle: 10,
} as const;

/**
 * Hover/drag timing, in one place so main and renderer share them.
 * Values come from the approved mock; the renderer owns the hover timers,
 * main owns the dock geometry.
 */
export const ISLAND_TIMING = {
  /** Hover-leave grace before a hover layer hides. */
  peekGraceMs: 240,
  /** Fade duration for hover layers (CSS mirrors this). */
  hideFadeMs: 180,
  /** Pull distance off a rail that detaches edge → blob. */
  detachPx: 78,
  /** Edge proximity that snaps a released blob to the rail. */
  snapPx: 54,
  /** Adjacent-edge distance that rounds docked corners. */
  cornerPx: 40,
  /** Minimum inset from display edges. */
  edgeMarginPx: 14,
  /** Wheel/cycle throttle, already the renderer's value. */
  wheelThrottleMs: 300,
} as const;
