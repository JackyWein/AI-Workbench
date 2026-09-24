import { ChevronDown, Check } from "lucide-react";
import { type JSX, type KeyboardEvent, useEffect, useId, useRef, useState } from "react";
import type { ColorMode, Theme } from "@ai-workbench/shared";
import { resolveTheme } from "@ai-workbench/ui";
import { systemPrefersDark, THEMES, themeEntry } from "../lib/themes.js";

interface ThemePickerProps {
  readonly value: Theme;
  /** The mode in force, so the trigger shows the theme as it is drawn now. */
  readonly mode: ColorMode;
  readonly onChange: (theme: Theme) => void;
}

/**
 * Chooses the theme from a list that shows each one: its name, a line on its
 * character and a small window drawn in the theme itself, light and dark. A listbox, so it
 * works from the keyboard like a select: arrows move, Enter or Space picks,
 * Escape closes, typing a letter jumps to a name.
 */
export function ThemePicker({ value, mode, onChange }: ThemePickerProps): JSX.Element {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(() => Math.max(0, THEMES.findIndex((theme) => theme.id === value)));
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const id = useId();
  const current = themeEntry(value);

  useEffect(() => {
    if (!open) {
      return undefined;
    }
    setActive(Math.max(0, THEMES.findIndex((theme) => theme.id === value)));
    listRef.current?.focus();
    const onPointerDown = (event: PointerEvent): void => {
      if (!rootRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open, value]);

  // The option under the keyboard stays in view in a list taller than the panel.
  useEffect(() => {
    if (open) {
      document.getElementById(`${id}-${active}`)?.scrollIntoView({ block: "nearest" });
    }
  }, [open, active, id]);

  const choose = (index: number): void => {
    const theme = THEMES[index];
    if (theme) {
      onChange(theme.id);
    }
    setOpen(false);
    triggerRef.current?.focus();
  };

  const onListKeyDown = (event: KeyboardEvent<HTMLUListElement>): void => {
    const last = THEMES.length - 1;
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        setActive((index) => Math.min(last, index + 1));
        return;
      case "ArrowUp":
        event.preventDefault();
        setActive((index) => Math.max(0, index - 1));
        return;
      case "Home":
        event.preventDefault();
        setActive(0);
        return;
      case "End":
        event.preventDefault();
        setActive(last);
        return;
      case "Enter":
      case " ":
        event.preventDefault();
        choose(active);
        return;
      case "Escape":
      case "Tab":
        if (event.key === "Escape") {
          event.preventDefault();
          triggerRef.current?.focus();
        }
        setOpen(false);
        return;
      default:
        if (event.key.length === 1) {
          const letter = event.key.toLowerCase();
          const from = THEMES.findIndex(
            (theme, index) => index > active && theme.name.toLowerCase().startsWith(letter),
          );
          const found =
            from !== -1 ? from : THEMES.findIndex((theme) => theme.name.toLowerCase().startsWith(letter));
          if (found !== -1) {
            setActive(found);
          }
        }
    }
  };

  return (
    <div className="theme-picker" ref={rootRef}>
      <button
        type="button"
        ref={triggerRef}
        className="theme-picker__trigger"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={`${id}-list`}
        aria-label={`Theme: ${current.name}`}
        onClick={() => setOpen((was) => !was)}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            setOpen(true);
          }
        }}
      >
        <ThemeSwatch theme={value} mode={mode} />
        <span className="theme-picker__name">{current.name}</span>
        <ChevronDown size={14} strokeWidth={1.75} aria-hidden="true" className="theme-picker__chevron" />
      </button>

      {open ? (
        <ul
          ref={listRef}
          id={`${id}-list`}
          className="theme-picker__list"
          role="listbox"
          aria-label="Theme"
          tabIndex={-1}
          aria-activedescendant={`${id}-${active}`}
          onKeyDown={onListKeyDown}
        >
          {THEMES.map((theme, index) => (
            <li
              key={theme.id}
              id={`${id}-${index}`}
              role="option"
              aria-selected={theme.id === value}
              data-active={index === active || undefined}
              className="theme-picker__option"
              onPointerEnter={() => setActive(index)}
              onClick={() => choose(index)}
            >
              <ThemeSwatch theme={theme.id} mode="both" />
              <span className="theme-picker__text">
                <span className="theme-picker__option-name">{theme.name}</span>
                <span className="theme-picker__description">{theme.description}</span>
              </span>
              {theme.id === value ? (
                <Check size={14} strokeWidth={2} aria-hidden="true" className="theme-picker__check" />
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/**
 * A tiny window in a theme: its sidebar, a title in its display face, a line
 * of text, a message and its accent. Drawn by the theme's own stylesheet —
 * the element carries the theme — so it can never disagree with the real
 * thing. "both" shows the light and the dark mode side by side, split.
 */
export function ThemeSwatch({
  theme,
  mode,
}: {
  readonly theme: Theme;
  readonly mode: ColorMode | "both";
}): JSX.Element {
  if (mode === "both") {
    return (
      <span className="theme-swatch-pair" aria-hidden="true">
        <SwatchWindow drawn={resolveTheme(theme, "light", false)} />
        <SwatchWindow drawn={resolveTheme(theme, "dark", true)} />
      </span>
    );
  }
  return (
    <span className="theme-swatch-pair" aria-hidden="true">
      <SwatchWindow drawn={resolveTheme(theme, mode, systemPrefersDark())} />
    </span>
  );
}

function SwatchWindow({ drawn }: { readonly drawn: string }): JSX.Element {
  return (
    <span className="theme-swatch" data-theme={drawn}>
      <span className="theme-swatch__side">
        <i />
        <i data-current="true" />
        <i />
      </span>
      <span className="theme-swatch__main">
        <span className="theme-swatch__title">Aa</span>
        <span className="theme-swatch__line" />
        <span className="theme-swatch__bubble" />
        <span className="theme-swatch__accent" />
      </span>
    </span>
  );
}
