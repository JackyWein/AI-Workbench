import type { JSX } from "react";

interface AppLogoProps {
  readonly size?: number;
  readonly className?: string;
  /** Plays the bars in one after another, for the start screen. */
  readonly animated?: boolean;
  /** Named for assistive technology when it stands alone. */
  readonly label?: string;
}

/**
 * AI Workbench's own mark, as on its icon: a rounded tile with three bars
 * of falling length, drawn from the theme's logo colours so it belongs to
 * every theme while keeping its shape. Geometry is the icon's, in its
 * 512-unit grid (build/icon.png).
 */
export function AppLogo({ size = 22, className, animated = false, label }: AppLogoProps): JSX.Element {
  const accessibility = label
    ? { role: "img" as const, "aria-label": label }
    : { "aria-hidden": true as const };
  return (
    <svg
      className={["app-logo", className].filter(Boolean).join(" ")}
      data-animated={animated || undefined}
      width={size}
      height={size}
      viewBox="0 0 512 512"
      {...accessibility}
    >
      <rect
        className="app-logo__tile"
        x="8"
        y="8"
        width="496"
        height="496"
        rx="112"
        strokeWidth="16"
      />
      <rect className="app-logo__bar" data-bar="1" x="128" y="152" width="256" height="44" rx="22" />
      <rect className="app-logo__bar" data-bar="2" x="128" y="234" width="188" height="44" rx="22" />
      <rect className="app-logo__bar app-logo__bar--dim" data-bar="3" x="128" y="316" width="120" height="44" rx="22" />
    </svg>
  );
}
