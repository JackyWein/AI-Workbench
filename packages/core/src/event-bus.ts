import type { AppEvent, AppEventType } from "@ai-workbench/shared";

export type AppEventListener = (event: AppEvent) => void;

/**
 * Domain event bus (spec §106). Publishers never know their subscribers, so the
 * main window, the Status Island and background services stay decoupled.
 */
export class EventBus {
  readonly #listeners = new Set<AppEventListener>();
  readonly #typed = new Map<AppEventType, Set<AppEventListener>>();

  publish(event: AppEvent): void {
    for (const listener of this.#listeners) {
      invoke(listener, event);
    }
    const typed = this.#typed.get(event.type);
    if (typed) {
      for (const listener of typed) {
        invoke(listener, event);
      }
    }
  }

  subscribe(listener: AppEventListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  on(type: AppEventType, listener: AppEventListener): () => void {
    let set = this.#typed.get(type);
    if (!set) {
      set = new Set();
      this.#typed.set(type, set);
    }
    set.add(listener);
    return () => set.delete(listener);
  }

  clear(): void {
    this.#listeners.clear();
    this.#typed.clear();
  }
}

/** One failing subscriber must not stop the others or the publisher. */
function invoke(listener: AppEventListener, event: AppEvent): void {
  try {
    listener(event);
  } catch {
    // Subscriber errors are contained here on purpose.
  }
}
