/**
 * Token values that behaviour depends on. Anything purely visual stays in
 * `tokens.css`; this module exists so timing and layout constants are not
 * duplicated as magic numbers in TypeScript.
 */
export const motion = {
  fast: 120,
  normal: 150,
  slow: 180,
} as const;

export const layout = {
  sidebarWidth: 244,
  contextWidth: 264,
  headerHeight: 46,
} as const;

export type ThemePreference = "system" | "dark" | "light";

/** Resolves the theme preference against the OS setting. */
export function resolveTheme(
  preference: ThemePreference,
  prefersDark: boolean,
): "dark" | "light" {
  if (preference === "system") {
    return prefersDark ? "dark" : "light";
  }
  return preference;
}

export { LOGOS, type LogoDefinition } from "./logos.js";
