import type { AppEvent } from "@ai-workbench/shared";
import { onAppEvent } from "./client.js";
import { useWorkbench } from "../store/workbench.js";

/**
 * Connects the main-process event stream to the store. Text deltas are
 * coalesced into one update per animation frame so a fast provider stream
 * cannot trigger a render per token (spec §112).
 */
export function attachEventStream(): () => void {
  const pending = new Map<string, { sessionId: string; text: string }>();
  let frame: number | null = null;

  const flush = (): void => {
    frame = null;
    const batch = new Map(pending);
    pending.clear();
    useWorkbench.getState().appendDeltas(batch);
  };

  const schedule = (): void => {
    frame ??= requestAnimationFrame(flush);
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

    // A completed message carries its full text, so any buffered delta for it
    // must land first to keep ordering intact.
    if (event.type === "message.updated" && pending.size > 0) {
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
    unsubscribe();
  };
}
