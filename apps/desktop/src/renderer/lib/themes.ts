import {
  colorModeSchema,
  themeSchema,
  type ColorMode,
  type Theme,
} from "@ai-workbench/shared";
import { resolveTheme } from "@ai-workbench/ui";

export interface ThemeEntry {
  readonly id: Theme;
  readonly name: string;
  /** One line on the character of the theme, shown under its name. */
  readonly description: string;
}

/**
 * The themes on offer, in the order the picker lists them. Each one's look,
 * light and dark, lives entirely in the stylesheets (packages/ui themes.css);
 * this is only how it is named. Typed against the setting, so a theme the
 * setting knows cannot be left out here.
 */
const ENTRIES: Record<Theme, Omit<ThemeEntry, "id">> = {
  quiet: { name: "Quiet", description: "Graphite or white, one soft blue. The default." },
  atelier: { name: "Atelier", description: "Warm paper or espresso, serif headings, terracotta." },
  mission: { name: "Mission Control", description: "A grid, lime signals, monospace detail." },
  playground: { name: "Playground", description: "Indigo and cream, thick ink outlines, bright colour." },
  aurora: { name: "Aurora", description: "Violet and cyan light, soft glass." },
  swiss: { name: "Swiss", description: "Black and white, one red, square and strict." },
};

export const THEMES: readonly ThemeEntry[] = (Object.keys(ENTRIES) as Theme[]).map((id) => ({
  id,
  ...ENTRIES[id],
}));

export function themeEntry(id: Theme): ThemeEntry {
  return { id, ...ENTRIES[id] };
}

export const MODES: ReadonlyArray<{ readonly value: ColorMode; readonly label: string }> = [
  { value: "system", label: "System" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
];

/** Whether the system asks for dark right now. */
export function systemPrefersDark(): boolean {
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

/*
 * The start screen shows before the settings arrive. The last choice is kept
 * in this window's storage so that screen is already in it, instead of
 * flashing the default first. The setting itself stays the source of truth.
 */
const REMEMBERED = "ai-workbench.appearance";

export function rememberAppearance(theme: Theme, mode: ColorMode): void {
  try {
    window.localStorage.setItem(REMEMBERED, JSON.stringify({ theme, mode }));
  } catch {
    // Storage can be unavailable; the start screen then uses the default.
  }
}

/** Puts the start screen in the theme and mode the app was last set to. */
export function applyRememberedAppearance(): void {
  let stored: unknown = null;
  try {
    stored = JSON.parse(window.localStorage.getItem(REMEMBERED) ?? "null");
  } catch {
    return;
  }
  if (typeof stored !== "object" || stored === null) {
    return;
  }
  const theme = themeSchema.safeParse((stored as Record<string, unknown>)["theme"]);
  const mode = colorModeSchema.safeParse((stored as Record<string, unknown>)["mode"]);
  if (theme.success && mode.success) {
    document.documentElement.dataset["theme"] = resolveTheme(theme.data, mode.data, systemPrefersDark());
  }
}
