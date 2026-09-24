import { type RefObject, useLayoutEffect, useState } from "react";

/** Where a dropdown panel opens beside its trigger, and how tall it may grow. */
export interface PanelFit {
  readonly placement: "above" | "below";
  /** Which of the trigger's edges the panel lines up with. */
  readonly align: "start" | "end";
  readonly maxHeight: number;
}

/** Space kept between the panel and the window's edge. */
const EDGE = 12;
/** Space between the trigger and the panel. */
const GAP = 8;

/**
 * A panel opens below its trigger when it fits there, and above when the
 * room below is short and there is more above — a picker at the foot of the
 * window opens upward instead of running off it. Either way it is never
 * taller than the room it has, and scrolls within that. Sideways it lines
 * up with the trigger's left edge and grows rightward when it fits that way,
 * and with its right edge otherwise.
 */
export function fitPanel(
  anchor: { readonly top: number; readonly bottom: number; readonly left: number },
  viewport: { readonly width: number; readonly height: number },
  wanted: { readonly width: number; readonly height: number },
): PanelFit {
  const below = viewport.height - anchor.bottom - GAP - EDGE;
  const above = anchor.top - GAP - EDGE;
  const placement = below >= wanted.height || below >= above ? "below" : "above";
  const room = placement === "below" ? below : above;
  const align = anchor.left + wanted.width <= viewport.width - EDGE ? "start" : "end";
  return { placement, align, maxHeight: Math.max(120, Math.floor(Math.min(wanted.height, room))) };
}

/** `fitPanel` for a panel anchored to `anchorRef`, kept current while open. */
export function usePanelFit(
  open: boolean,
  anchorRef: RefObject<HTMLElement | null>,
  width: number,
  height: number,
): PanelFit {
  const [fit, setFit] = useState<PanelFit>({ placement: "below", align: "end", maxHeight: height });
  useLayoutEffect(() => {
    if (!open) {
      return;
    }
    const measure = (): void => {
      const anchor = anchorRef.current;
      if (anchor) {
        const viewport = { width: window.innerWidth, height: window.innerHeight };
        setFit(fitPanel(anchor.getBoundingClientRect(), viewport, { width, height }));
      }
    };
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [open, anchorRef, width, height]);
  return fit;
}
