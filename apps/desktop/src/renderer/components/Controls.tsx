import { useState, type JSX, type ReactNode } from "react";
import { ChevronRight } from "lucide-react";

/**
 * The shared settings grammar: a titled group of hairline-separated rows,
 * each a label with a description and one control docked on the right.
 */
export function SettingGroup({
  title,
  lede,
  children,
}: {
  readonly title: string;
  readonly lede?: string;
  readonly children: ReactNode;
}): JSX.Element {
  return (
    <section className="setting-group" aria-label={title}>
      <header className="setting-group__header">
        <h2 className="setting-group__title">{title}</h2>
        {lede ? <p className="setting-group__lede">{lede}</p> : null}
      </header>
      <div className="setting-group__panel">{children}</div>
    </section>
  );
}

export function SettingRow({
  label,
  description,
  children,
  muted = false,
}: {
  readonly label: string;
  readonly description?: ReactNode;
  readonly children?: ReactNode;
  /** Dims a row whose setting has no effect right now (its parent is off). */
  readonly muted?: boolean;
}): JSX.Element {
  return (
    <div className="setting" data-muted={muted || undefined}>
      <div className="setting__text">
        <p className="setting__label">{label}</p>
        {description ? <p className="setting__description">{description}</p> : null}
      </div>
      {children ? <div className="setting__control">{children}</div> : null}
    </div>
  );
}

/** Rows that are rarely needed, one click away at the foot of a group. */
export function SettingDisclosure({
  label,
  children,
}: {
  readonly label: string;
  readonly children: ReactNode;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        className="setting-disclosure"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        <ChevronRight size={13} strokeWidth={2} aria-hidden="true" />
        {open ? `Hide ${label.toLowerCase()}` : label}
      </button>
      {open ? <div className="setting-disclosure__body">{children}</div> : null}
    </>
  );
}

export function Switch({
  checked,
  label,
  onChange,
  disabled = false,
}: {
  readonly checked: boolean;
  readonly label: string;
  readonly onChange: (checked: boolean) => void;
  readonly disabled?: boolean;
}): JSX.Element {
  return (
    <input
      type="checkbox"
      role="switch"
      className="switch"
      checked={checked}
      aria-label={label}
      disabled={disabled}
      onChange={(event) => onChange(event.target.checked)}
    />
  );
}

export interface SegmentOption<T extends string> {
  readonly value: T;
  readonly label: string;
}

/** A small set of exclusive choices, all visible at once. */
export function Segmented<T extends string>({
  value,
  options,
  label,
  onChange,
}: {
  readonly value: T;
  readonly options: ReadonlyArray<SegmentOption<T>>;
  readonly label: string;
  readonly onChange: (value: T) => void;
}): JSX.Element {
  return (
    <div className="segmented" role="radiogroup" aria-label={label}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="radio"
          className="segmented__item"
          aria-checked={option.value === value}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

/**
 * A select over typed options: the change handler gets the option itself,
 * so no string from the DOM has to be trusted as one of the values.
 */
export function Choice<T extends string>({
  value,
  options,
  label,
  onChange,
}: {
  readonly value: T;
  readonly options: ReadonlyArray<SegmentOption<T>>;
  readonly label: string;
  readonly onChange: (value: T) => void;
}): JSX.Element {
  return (
    <select
      className="select"
      value={value}
      aria-label={label}
      onChange={(event) => {
        const picked = options.find((option) => option.value === event.target.value);
        if (picked) {
          onChange(picked.value);
        }
      }}
    >
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  );
}

/** A key combination drawn as keycaps: "Ctrl Shift A" → three caps. */
export function Keys({ combo }: { readonly combo: string }): JSX.Element {
  return (
    <span className="keys">
      {combo.split(" ").map((key, index) => (
        <kbd className="kbd" key={`${key}-${index}`}>
          {key}
        </kbd>
      ))}
    </span>
  );
}
