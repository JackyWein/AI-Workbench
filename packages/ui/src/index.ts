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
  composerMaxHeight: 220,
} as const;

/**
 * Resolves a theme preference to the theme to draw: "system" follows the OS
 * between the house theme's dark and light modes, anything else is itself.
 */
export function resolveTheme<T extends string>(
  preference: T | "system",
  prefersDark: boolean,
): Exclude<T, "system"> | "dark" | "light" {
  if (preference === "system") {
    return prefersDark ? "dark" : "light";
  }
  return preference as Exclude<T, "system">;
}

export { LOGOS, type LogoDefinition } from "./logos.js";
