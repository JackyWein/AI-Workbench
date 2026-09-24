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
 * The theme to draw, as the stylesheets name it: Quiet is "dark" or "light",
 * every other theme "<theme>-dark" or "<theme>-light". The "system" mode
 * follows the OS.
 */
export function resolveTheme(
  theme: string,
  mode: "system" | "dark" | "light",
  prefersDark: boolean,
): string {
  const scheme = mode === "system" ? (prefersDark ? "dark" : "light") : mode;
  return theme === "quiet" ? scheme : `${theme}-${scheme}`;
}

export { LOGOS, type LogoDefinition } from "./logos.js";
