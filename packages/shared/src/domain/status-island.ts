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
