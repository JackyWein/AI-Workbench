import { type JSX, useCallback, useEffect, useRef, useState, type ReactNode } from "react";

interface PopoverProps {
  /** Accessible name of the panel. */
  readonly title: string;
  readonly trigger: ReactNode;
  readonly children: ReactNode;
  readonly triggerClassName?: string;
  /**
   * Marks the trigger as the current item (for example the selected row).
   * Maps to `aria-current`, which the plain button API cannot express.
   */
  readonly current?: boolean;
  /** Runs when the trigger is activated, in addition to toggling the panel. */
  readonly onTriggerClick?: () => void;
  /** Whether activating the trigger toggles the panel (default true). */
  readonly toggleOnClick?: boolean;
}

/**
 * Secondary information layer (spec §64). It opens on hover, on keyboard focus
 * and on click, because hover must never be the only way to reach the detail
 * (spec §86). Where the trigger is itself an action (for example selecting a
 * row), the action runs through `onTriggerClick` and the panel can stay a
 * hover/focus detail with `toggleOnClick={false}`.
 */
export function Popover({
  title,
  trigger,
  children,
  triggerClassName,
  current,
  onTriggerClick,
  toggleOnClick = true,
}: PopoverProps): JSX.Element {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  const close = useCallback(() => setOpen(false), []);

  useEffect(() => {
    if (!open) {
      return;
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        close();
        // Keyboard users land back where they opened the panel from.
        triggerRef.current?.focus();
      }
    };
    const onPointerDown = (event: PointerEvent): void => {
      if (!containerRef.current?.contains(event.target as Node)) {
        close();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("pointerdown", onPointerDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("pointerdown", onPointerDown);
    };
  }, [open, close]);

  return (
    <div
      className="popover"
      ref={containerRef}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
          close();
        }
      }}
    >
      <button
        type="button"
        ref={triggerRef}
        className={triggerClassName}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-current={current}
        onClick={() => {
          if (toggleOnClick) {
            setOpen((value) => !value);
          }
          onTriggerClick?.();
        }}
        onFocus={() => setOpen(true)}
      >
        {trigger}
      </button>
      {open ? (
        <div className="popover__panel" role="dialog" aria-label={title}>
          <p className="popover__title">{title}</p>
          {children}
        </div>
      ) : null}
    </div>
  );
}
