import { type JSX, useCallback, useEffect, useRef, useState, type ReactNode } from "react";

interface PopoverProps {
  /** Accessible name of the panel. */
  readonly title: string;
  readonly trigger: ReactNode;
  readonly children: ReactNode;
  readonly triggerClassName?: string;
}

/**
 * Secondary information layer (spec §64). It opens on hover, on keyboard focus
 * and on click, because hover must never be the only way to reach the detail
 * (spec §86).
 */
export function Popover({
  title,
  trigger,
  children,
  triggerClassName,
}: PopoverProps): JSX.Element {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const close = useCallback(() => setOpen(false), []);

  useEffect(() => {
    if (!open) {
      return;
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        close();
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
        className={triggerClassName}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
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
