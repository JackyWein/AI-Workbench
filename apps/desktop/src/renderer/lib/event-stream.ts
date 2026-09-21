import type { AppEvent } from "@ai-workbench/shared";
import { onAppEvent } from "./client.js";
import { useWorkbench } from "../store/workbench.js";

/**
 * How long a delta batch may wait for its animation frame before a fallback
 * flush guarantees progress (a hidden or minimized window throttles rAF).
 */
const FLUSH_FALLBACK_MS = 100;

/**
 * Connects the main-process event stream to the store. Text deltas are
 * coalesced into one update per animation frame so a fast provider stream
 * cannot trigger a render per token (spec §112).
 */
export function attachEventStream(): () => void {
  const pending = new Map<string, { sessionId: string; text: string }>();
  let frame: number | null = null;
  let fallback: ReturnType<typeof setTimeout> | null = null;

  const flush = (): void => {
    frame = null;
    if (fallback !== null) {
      clearTimeout(fallback);
      fallback = null;
    }
    const batch = new Map(pending);
    pending.clear();
    useWorkbench.getState().appendDeltas(batch);
  };

  const schedule = (): void => {
    frame ??= requestAnimationFrame(flush);
    // rAF stalls when the window is hidden; the timeout keeps the stream
    // moving and is cancelled by the frame when it does run.
    fallback ??= setTimeout(() => {
      fallback = null;
      if (frame !== null) {
        cancelAnimationFrame(frame);
      }
      flush();
    }, FLUSH_FALLBACK_MS);
  };

  const unsubscribe = onAppEvent((event: AppEvent) => {
    if (event.type === "message.delta") {
      const existing = pending.get(event.messageId);
      pending.set(event.messageId, {
        sessionId: event.sessionId,
        text: (existing?.text ?? "") + event.text,
      });
      schedule();
      return;
    }

    // A finished message carries its full text, so any buffered delta for it
    // must land first to keep ordering intact. This covers created, updated
    // and failed; unrelated events leave the batch alone.
    if (event.type.startsWith("message.") && pending.size > 0) {
      if (frame !== null) {
        cancelAnimationFrame(frame);
      }
      flush();
    }

    useWorkbench.getState().applyEvent(event);
  });

  return () => {
    if (frame !== null) {
      cancelAnimationFrame(frame);
    }
    if (fallback !== null) {
      clearTimeout(fallback);
    }
    unsubscribe();
  };
}
