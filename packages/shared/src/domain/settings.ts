import { z } from "zod";
import {
  defaultIslandPreferences,
  islandPreferencesSchema,
} from "./status-island.js";

/**
 * How the application looks: a theme — its colours, type and shape — and a
 * mode it is shown in. Quiet is the house theme; the others are complete
 * themes of their own. Every theme has a light and a dark mode.
 */
export const themeSchema = z.enum(["quiet", "atelier", "mission", "playground", "aurora", "swiss"]);
export type Theme = z.infer<typeof themeSchema>;

/** Light, dark, or whichever the system is set to. */
export const colorModeSchema = z.enum(["system", "dark", "light"]);
export type ColorMode = z.infer<typeof colorModeSchema>;

/** What the island is told so it looks like the main window. */
export interface Appearance {
  readonly theme: Theme;
  readonly mode: ColorMode;
}

/**
 * The mode each theme came in when a theme was a single choice (0.0.6), so
 * someone who picked one keeps what they saw.
 */
const EARLIER_MODE: Readonly<Record<string, "dark" | "light">> = {
  atelier: "light",
  mission: "dark",
  playground: "light",
  aurora: "dark",
  swiss: "light",
};

/**
 * Settings as stored by an earlier version, brought to this shape. Up to
 * 0.0.6 the mode lived inside the theme: "dark", "light" and "system" were
 * Quiet's, and each other theme had one fixed mode. Anything else passes
 * through for the schema to judge.
 */
export function upgradeStoredSettings(value: unknown): unknown {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return value;
  }
  const stored = value as Record<string, unknown>;
  if ("mode" in stored) {
    return stored;
  }
  const theme = stored["theme"];
  if (theme === "system" || theme === "dark" || theme === "light") {
    return { ...stored, theme: "quiet", mode: theme };
  }
  if (typeof theme === "string" && theme in EARLIER_MODE) {
    return { ...stored, mode: EARLIER_MODE[theme] };
  }
  return stored;
}

export const densitySchema = z.enum(["comfortable", "compact"]);
export type Density = z.infer<typeof densitySchema>;

/**
 * Application settings. Dark mode first (spec §110): Quiet's dark is the
 * house look, and a new install follows the system's light or dark.
 */
export const appSettingsSchema = z.object({
  theme: themeSchema,
  mode: colorModeSchema,
  density: densitySchema,
  /** Developer Mode exposes raw normalized events and logs (spec §111). */
  developerMode: z.boolean(),
  defaultProviderId: z.string().min(1).nullable(),
  /**
   * New versions download in the background and install when the app quits.
   * Defaulted so settings stored before it existed still read.
   */
  autoUpdate: z.boolean().default(true),
  /** The floating companion window, off until the user asks for it (spec §95). */
  statusIsland: islandPreferencesSchema,
});
export type AppSettings = z.infer<typeof appSettingsSchema>;

export const defaultAppSettings: AppSettings = {
  theme: "quiet",
  mode: "system",
  density: "comfortable",
  developerMode: false,
  defaultProviderId: null,
  autoUpdate: true,
  statusIsland: defaultIslandPreferences,
};

export const updateSettingsInputSchema = appSettingsSchema.partial();
export type UpdateSettingsInput = z.infer<typeof updateSettingsInputSchema>;
