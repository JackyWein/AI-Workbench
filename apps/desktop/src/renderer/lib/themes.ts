import { themeSchema, type Theme } from "@ai-workbench/shared";
import { resolveTheme } from "@ai-workbench/ui";

export interface ThemeEntry {
  readonly id: Theme;
  readonly name: string;
  /** One line on the character of the theme, shown under its name. */
  readonly description: string;
}

/**
 * The themes on offer, in the order the picker lists them. Each one's look
 * lives entirely in the stylesheets (packages/ui themes.css); this is only
 * how it is named. Typed against the setting, so a theme the setting knows
 * cannot be left out here.
 */
const ENTRIES: Record<Theme, Omit<ThemeEntry, "id">> = {
  system: { name: "Quiet", description: "Dark or light, the way your system is set." },
  dark: { name: "Quiet Dark", description: "Graphite and one soft blue. The default." },
  light: { name: "Quiet Light", description: "The same calm, on white." },
  atelier: { name: "Atelier", description: "Warm paper, serif headings, terracotta." },
  mission: { name: "Mission Control", description: "Near-black on a grid, lime signals, monospace." },
  playground: { name: "Playground", description: "Cream and indigo, thick ink outlines, bright colour." },
  aurora: { name: "Aurora", description: "Night blue lit by violet and cyan, soft glass." },
  swiss: { name: "Swiss", description: "Black on white, one red, square and strict." },
};

export const THEMES: readonly ThemeEntry[] = (Object.keys(ENTRIES) as Theme[]).map((id) => ({
  id,
  ...ENTRIES[id],
}));

export function themeEntry(id: Theme): ThemeEntry {
  return { id, ...ENTRIES[id] };
}

/*
 * The start screen shows before the settings arrive. The last theme is kept
 * in this window's storage so that screen is already in it, instead of
 * flashing the default first. The setting itself stays the source of truth.
 */
const REMEMBERED = "ai-workbench.theme";

export function rememberTheme(theme: Theme): void {
  try {
    window.localStorage.setItem(REMEMBERED, theme);
  } catch {
    // Storage can be unavailable; the start screen then uses the default.
  }
}

/** Puts the start screen in the theme the app was last set to. */
export function applyRememberedTheme(): void {
  let stored: string | null = null;
  try {
    stored = window.localStorage.getItem(REMEMBERED);
  } catch {
    return;
  }
  const parsed = themeSchema.safeParse(stored);
  if (parsed.success) {
    const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
    document.documentElement.dataset["theme"] = resolveTheme(parsed.data, prefersDark);
  }
}
