import {
  ISLAND_PRIORITY,
  defaultIslandPreferences,
  islandPreferencesSchema,
  type IslandEntry,
  type IslandPreferences,
  type IslandSessionSummary,
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
    this.#settle();
    return this.setPreferences({ pinnedWidget: widget });
  }

  /** Steps through the widgets that currently have something to say. */
  cycle(direction: 1 | -1 = 1): IslandState {
    // Touching the island acknowledges the news holding it, so the step is
    // taken from where the island settles rather than from the flash. A step
    // that counted from a passing announcement would land somewhere the user
    // could not predict from what the island shows a second later.
    const settled = this.dismissOverride();
    const available = settled.entries;
    if (available.length <= 1) {
      return settled;
    }
    const currentIndex = available.findIndex(
      (entry) => entry.widget === settled.current.widget,
    );
    const next = (currentIndex + direction + available.length) % available.length;
    this.#rotation = next;
    // Cycling by hand is a deliberate choice, so it takes over from automatic
    // selection until the user pins or the entry disappears.
    return this.pin(available[next]?.widget ?? null);
  }

  /** Lets the island settle back after the user handled something (spec §97). */
  dismissOverride(): IslandState {
    this.#settle();
    return this.#refresh();
  }

  /** Notes that a piece of news has had its moment, with bounded memory. */
  #remember(key: string): void {
    this.#seen.add(key);
    // Long-lived app, bounded memory: forget the oldest news first.
    if (this.#seen.size > 200) {
      const oldest = this.#seen.values().next().value;
      if (oldest !== undefined) {
        this.#seen.delete(oldest);
      }
    }
  }

  /**
   * Touching the island acknowledges what it was showing: the entry holding it
   * lets go, and the news it was about does not take it again a moment later.
   * Without this an explicit choice — pinning, cycling, dismissing — would be
   * undone by the next refresh while that news is still unseen.
   */
  #settle(): void {
    this.#override = null;
    for (const entry of this.#state.entries) {
      if (entry.priority >= ISLAND_PRIORITY.workCompleted) {
        this.#remember(entry.key);
      }
    }
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
      if (widget.id !== "idle" && !enabled.has(widget.toggle ?? widget.id)) {
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
      this.#remember(urgent.key);
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
      sessions: summarizeSessions(this.#sources.sessions, now),
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

/** Sessions active within this window count as "recent" for the idle face. */
const RECENT_MS = 24 * 60 * 60 * 1000;

/** Counts the resting sessions from what they last did, nothing more. */
export function summarizeSessions(
  sessions: IslandSources["sessions"],
  now: Date,
): IslandSessionSummary {
  const resting = sessions.filter((session) => !session.busy);
  const recent = resting.filter(
    (session) => now.getTime() - session.lastActiveAt.getTime() <= RECENT_MS,
  );
  const oldest = recent.reduce<(typeof recent)[number] | null>(
    (best, session) => (!best || session.lastActiveAt < best.lastActiveAt ? session : best),
    null,
  );
  const newest = resting.reduce<(typeof resting)[number] | null>(
    (best, session) => (!best || session.lastActiveAt > best.lastActiveAt ? session : best),
    null,
  );
  const ref = (
    session: (typeof resting)[number] | null,
  ): IslandSessionSummary["last"] =>
    session ? { name: session.name.slice(0, 120), icon: session.icon, at: session.lastActiveAt } : null;
  return { recent: recent.length, longestIdle: ref(oldest), last: ref(newest) };
}

function emptySources(now: Date): IslandSources {
  return {
    usage: null,
    runs: [],
    busySessions: [],
    providers: [],
    sessions: [],
    attention: [],
    questions: [],
    errors: [],
    brokenConnections: [],
    completed: [],
    now,
  };
}
