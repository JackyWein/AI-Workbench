import { type JSX, useId, useMemo } from "react";
import { LOGOS } from "@ai-workbench/ui";

interface LogoProps {
  /** A logo key such as a provider's `icon`; unknown keys get a letter mark. */
  readonly name: string | undefined;
  /** Used for the letter mark and the accessible name. */
  readonly label: string;
  readonly size?: number;
  /** Decorative when the name is written next to it anyway. */
  readonly decorative?: boolean;
}

/**
 * A tool's or service's logo, so entries can be told apart at a glance
 * (spec §74 keeps it small and quiet). The marks are static, vendored SVG;
 * their gradient ids are made unique per instance so two logos on one screen
 * cannot borrow each other's fills.
 */
export function Logo({ name, label, size = 16, decorative = true }: LogoProps): JSX.Element {
  const instance = useId().replace(/[^A-Za-z0-9_-]/g, "");
  const definition = name ? LOGOS[name] : undefined;

  const markup = useMemo(() => {
    if (!definition) {
      return null;
    }
    const ids = [...definition.svg.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1] ?? "");
    let svg = definition.svg;
    for (const id of ids) {
      svg = svg
        .replaceAll(`id="${id}"`, `id="${id}-${instance}"`)
        .replaceAll(`url(#${id})`, `url(#${id}-${instance})`)
        .replaceAll(`href="#${id}"`, `href="#${id}-${instance}"`);
    }
    return svg;
  }, [definition, instance]);

  const accessibility = decorative
    ? { "aria-hidden": true as const }
    : { role: "img" as const, "aria-label": label };

  if (!markup) {
    return (
      <span
        className="logo logo--letter"
        style={{ width: size, height: size, fontSize: Math.round(size * 0.6) }}
        {...accessibility}
      >
        {label.trim().charAt(0).toUpperCase() || "?"}
      </span>
    );
  }

  return (
    <span
      className="logo"
      style={{ width: size, height: size }}
      {...accessibility}
      // The markup is a vendored constant from @ai-workbench/ui, never input.
      dangerouslySetInnerHTML={{ __html: markup }}
    />
  );
}
