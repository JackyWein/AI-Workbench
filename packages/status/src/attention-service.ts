import {
  ISLAND_PRIORITY,
  defaultIslandPreferences,
  islandPreferencesSchema,
  type IslandEntry,
  type IslandPreferences,
  type IslandState,
  type IslandWidgetId,
  type Logger,
} from "@ai-workbench/shared";
import { builtInWidgets, idleWidget, type IslandSources, type IslandWidget } from "./widgets.js";

/**
 * `StatusAttentionService` (spec §102).
 *
 * Everything that decides what the island shows lives here: the widget
 * registry, the priority engine, the attention queue and the island's own
 * state. No UI component makes a priority decision of its own (spec §99).
 */
export interface StatusAttentionServiceOptions {
  readonly logger: Logger;
  readonly preferences?: Partial<IslandPreferences>;
  readonly widgets?: IslandWidget[];
  /** How long an overriding entry holds the island before it settles back. */
  readonly expandMs?: number;
  readonly now?: () => Date;
}

export class StatusAttentionService {
  readonly #logger: Logger;
  readonly #widgets = new Map<IslandWidgetId, IslandWidget>();
  readonly #listeners = new Set<(state: IslandState) => void>();
  readonly #expandMs: number;
  readonly #now: () => Date;

  #preferences: IslandPreferences;
  #sources: IslandSources;
  #state: IslandState;
  /** The entry currently holding the island, and until when (spec §97). */
  #override: { entry: IslandEntry; until: Date } | null = null;
  /** Entry keys already shown, so the same news does not expand twice. */
  readonly #seen = new Set<string>();
  /** Where automatic rotation currently is. */
  #rotation = 0;

  constructor(options: StatusAttentionServiceOptions) {
    this.#logger = options.logger.child("STATUS_ISLAND");
    this.#expandMs = options.expandMs ?? 8_000;
    this.#now = options.now ?? (() => new Date());
    this.#preferences = islandPreferencesSchema.parse({
      ...defaultIslandPreferences,
      ...options.preferences,
    });

    for (const widget of options.widgets ?? builtInWidgets) {
      this.#widgets.set(widget.id, widget);
    }

    this.#sources = emptySources(this.#now());
    this.#state = this.#compute();
  }

  get state(): IslandState {
    return this.#state;
  }

  get preferences(): IslandPreferences {
    return this.#preferences;
  }

  register(widget: IslandWidget): void {
    this.#widgets.set(widget.id, widget);
    this.#refresh();
  }

  subscribe(listener: (state: IslandState) => void): () => void {
    this.#listeners.add(listener);
    listener(this.#state);
    return () => this.#listeners.delete(listener);
  }

  /** Everything the island can show is derived from these, and nothing else. */
  update(sources: Partial<IslandSources>): IslandState {
    this.#sources = { ...this.#sources, ...sources, now: sources.now ?? this.#now() };
    return this.#refresh();
  }

  setPreferences(patch: Partial<IslandPreferences>): IslandState {
    this.#preferences = islandPreferencesSchema.parse({ ...this.#preferences, ...patch });
    this.#logger.debug("Island preferences changed", {
      enabled: this.#preferences.enabled,
      pinned: this.#preferences.pinnedWidget,
    });
    return this.#refresh();
  }

  /** Pinning, or null for automatic (spec §100). */
  pin(widget: IslandWidgetId | null): IslandState {
    return this.setPreferences({ pinnedWidget: widget });
  }

  /** Steps through the widgets that currently have something to say. */
  cycle(direction: 1 | -1 = 1): IslandState {
    const available = this.#state.entries;
    if (available.length <= 1) {
      return this.#state;
    }
    const currentIndex = available.findIndex(
      (entry) => entry.widget === this.#state.current.widget,
    );
    const next = (currentIndex + direction + available.length) % available.length;
    this.#rotation = next;
    // Cycling by hand is a deliberate choice, so it takes over from automatic
    // selection until the user pins or the entry disappears.
    return this.pin(available[next]?.widget ?? null);
  }

  /** Lets the island settle back after the user handled something (spec §97). */
  dismissOverride(): IslandState {
    this.#override = null;
    return this.#refresh();
  }

  #refresh(): IslandState {
    this.#state = this.#compute();
    for (const listener of this.#listeners) {
      try {
        listener(this.#state);
      } catch {
        // One broken listener must not stop the island updating.
      }
    }
    return this.#state;
  }

  #compute(): IslandState {
    const now = this.#sources.now;
    const enabled = new Set(this.#preferences.enabledWidgets);

    const entries: IslandEntry[] = [];
    for (const widget of this.#widgets.values()) {
      if (widget.id !== "idle" && !enabled.has(widget.id)) {
        continue;
      }
      const entry = widget.build(this.#sources);
      if (entry && widget.id !== "idle") {
        entries.push(entry);
      }
    }
    entries.sort((left, right) => right.priority - left.priority);

    const idle = idleWidget.build(this.#sources)!;
    const quiet = this.#quietEntry(entries, idle);

    // Something important and new takes the island for a moment, then it
    // settles back to whatever was there (spec §97).
    const urgent = entries.find(
      (entry) => entry.priority >= ISLAND_PRIORITY.workCompleted && !this.#seen.has(entry.key),
    );
    if (urgent) {
      this.#seen.add(urgent.key);
      // Long-lived app, bounded memory: forget the oldest news first.
      if (this.#seen.size > 200) {
        const oldest = this.#seen.values().next().value;
        if (oldest !== undefined) {
          this.#seen.delete(oldest);
        }
      }
      this.#override = { entry: urgent, until: new Date(now.getTime() + this.#expandMs) };
    } else if (this.#override && this.#override.until.getTime() <= now.getTime()) {
      this.#override = null;
    } else if (
      this.#override &&
      !entries.some((entry) => entry.key === this.#override?.entry.key)
    ) {
      // The thing it was about is gone; there is nothing to hold for.
      this.#override = null;
    }

    const holding = this.#override?.entry;
    return {
      current: holding ?? quiet,
      expanded: Boolean(holding && this.#preferences.autoExpand),
      entries,
      preferences: this.#preferences,
    };
  }

  /** What the island shows when nothing is shouting: pinned, else the best. */
  #quietEntry(entries: readonly IslandEntry[], idle: IslandEntry): IslandEntry {
    const pinned = this.#preferences.pinnedWidget;
    if (pinned) {
      const found = entries.find((entry) => entry.widget === pinned);
      if (found) {
        return found;
      }
      // A pinned widget with nothing to say stays honest rather than silently
      // showing something the user did not choose.
      return {
        ...idle,
        title: `${this.#widgets.get(pinned)?.displayName ?? pinned} · nothing to report`,
      };
    }

    if (this.#preferences.autoRotateSeconds > 0 && entries.length > 1) {
      const step = Math.floor(
        this.#sources.now.getTime() / (this.#preferences.autoRotateSeconds * 1000),
      );
      this.#rotation = step % entries.length;
      return entries[this.#rotation] ?? idle;
    }

    const preferred = entries.find(
      (entry) => entry.widget === this.#preferences.defaultWidget,
    );
    // The highest priority wins; the default widget only breaks a tie at the
    // bottom, where nothing is happening.
    const best = entries[0];
    if (!best) {
      return idle;
    }
    return best.priority <= ISLAND_PRIORITY.providerUsage && preferred ? preferred : best;
  }
}

function emptySources(now: Date): IslandSources {
  return {
    usage: null,
    runs: [],
    busySessions: [],
    attention: [],
    errors: [],
    brokenConnections: [],
    completed: [],
    now,
  };
}
