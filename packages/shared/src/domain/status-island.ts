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

/**
 * What a drag looks like right now: the rail the pill rides (null while it is
 * a free blob), and the rail a free blob would dock to if dropped here. After
 * release `active` is false and `edge` is where the unit settled.
 */
export const islandDragSchema = z.object({
  active: z.boolean(),
  edge: islandEdgeSchema.nullable(),
  snap: islandEdgeSchema.nullable(),
});
export type IslandDrag = z.infer<typeof islandDragSchema>;

export const islandPreferencesSchema = z.object({
  enabled: z.boolean().default(true),
  startWithApp: z.boolean().default(true),
  stayVisibleWhenHidden: z.boolean().default(true),
  /** When false (default) the island stays visible even with focused main. */
  hideWhenMainFocused: z.boolean().default(false),
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
  /** Where the pill's center sits along its rail, in pixels; null means centered. */
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
  /** An agent's terminal tile, shown in its workspace's agents view. */
  workspaceId: z.string().min(1).optional(),
  tileId: z.string().min(1).optional(),
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

/**
 * One agent at work, for the island's agent list. The clock runs from
 * `startedAt`, which is when the work really began; null shows no clock
 * rather than one that restarts on every refresh.
 */
export const islandAgentRowSchema = z.object({
  key: z.string().min(1),
  title: z.string().min(1).max(120),
  /** What it reported so far (tokens, context), or its state; never invented. */
  detail: z.string().max(160).default(""),
  icon: z.string().max(120).nullable().default(null),
  startedAt: z.date().nullable().default(null),
  target: islandTargetSchema.nullable().default(null),
});
export type IslandAgentRow = z.infer<typeof islandAgentRowSchema>;

/** One provider usage row, from real snapshots only — never estimated. */
export const islandUsageRowSchema = z.object({
  providerId: z.string().min(1),
  name: z.string().min(1).max(120),
  /** Window label from the provider (Weekly, 5-hour, Daily). */
  window: z.string().max(60).default(""),
  /** Percent remaining, or null when the provider did not report a number. */
  percentLeft: z.number().min(0).max(100).nullable(),
  /** Provider mark key; null falls back to a letter. */
  icon: z.string().max(120).nullable().default(null),
  /** Why there is no number, when there is none ("Usage unavailable"). */
  note: z.string().max(80).default(""),
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
  /** Each agent behind a working entry, one row apiece; empty otherwise. */
  agents: z.array(islandAgentRowSchema).max(24).default([]),
});
export type IslandEntry = z.infer<typeof islandEntrySchema>;

/** A session the island can name: what it is and when it last did something. */
const islandSessionRefSchema = z.object({
  name: z.string().min(1).max(120),
  icon: z.string().max(120).nullable().default(null),
  at: z.date(),
});

/**
 * The quiet picture, counted from real sessions: how many were active in the
 * last day and are resting now, which one has rested longest, and the last
 * one that did anything at all.
 */
export const islandSessionSummarySchema = z.object({
  recent: z.number().int().nonnegative(),
  longestIdle: islandSessionRefSchema.nullable(),
  last: islandSessionRefSchema.nullable(),
});
export type IslandSessionSummary = z.infer<typeof islandSessionSummarySchema>;

export const islandStateSchema = z.object({
  /** What the island is showing right now. */
  current: islandEntrySchema,
  /** True while an important entry is overriding the quiet one (spec §97). */
  expanded: z.boolean(),
  /** Everything currently worth showing, highest priority first. */
  entries: z.array(islandEntrySchema),
  preferences: islandPreferencesSchema,
  sessions: islandSessionSummarySchema.default({ recent: 0, longestIdle: null, last: null }),
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
