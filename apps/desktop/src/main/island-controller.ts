import type { BrowserWindow } from "electron";
import {
  ISLAND_NAVIGATE_CHANNEL,
  type IslandPreferences,
  type IslandState,
  type IslandTarget,
  type IslandWidgetId,
} from "@ai-workbench/shared";
import type { IslandSources } from "@ai-workbench/status";
import type { AppServices } from "./services.js";
import { StatusIslandWindow } from "./status-island.js";
import { StatusTray } from "./tray.js";

/**
 * Ties the attention service to the window and the tray (spec §102).
 *
 * The service decides what should be shown; this only collects what the
 * application currently knows, hands it over, and shows the answer. No
 * priority decision is made here.
 */
export interface IslandControllerOptions {
  readonly services: AppServices;
  readonly islandFile: string;
  readonly preloadFile: string;
  readonly devServerUrl?: string | undefined;
  readonly focusMainWindow: () => BrowserWindow | null;
  readonly quit: () => void;
}

export class IslandController {
  readonly #options: IslandControllerOptions;
  readonly #services: AppServices;
  readonly #window: StatusIslandWindow;
  readonly #tray: StatusTray;
  #unsubscribe: (() => void) | null = null;
  #eventsUnsubscribe: (() => void) | null = null;
  #timer: NodeJS.Timeout | null = null;
  #refreshing = false;
  #needsRefresh = false;
  #lastSessionCount = 0;
  #lastRunCount = 0;
  /** True while the island is hidden only because the main window is. */
  #hiddenWithMain = false;
  /** Serializes preference writes so concurrent callers cannot interleave. */
  #preferencesChain: Promise<void> = Promise.resolve();

  constructor(options: IslandControllerOptions) {
    this.#options = options;
    this.#services = options.services;

    this.#window = new StatusIslandWindow({
      logger: options.services.logger,
      islandFile: options.islandFile,
      preloadFile: options.preloadFile,
      devServerUrl: options.devServerUrl,
      onMoved: ({ x, y, displayId }) => {
        // A dragged island keeps where it was put, across restarts (spec §95).
        // Positions that are already stored are not written again, so settling
        // the window cannot turn into a write loop.
        const current = this.#services.attention.preferences;
        if (
          current.position === "custom" &&
          current.customX === x &&
          current.customY === y &&
          current.displayId === displayId
        ) {
          return;
        }
        void this.setPreferences({
          position: "custom",
          customX: x,
          customY: y,
          displayId,
        }).catch((error: unknown) =>
          this.#services.logger.warn("Could not persist dragged island position", {
            error: error instanceof Error ? error.message : String(error),
          }),
        );
      },
    });

    this.#tray = new StatusTray({
      logger: options.services.logger,
      islandVisible: () => this.#window.visible,
      actions: {
        openMainWindow: () => options.focusMainWindow(),
        toggleIsland: () => this.#window.toggle(),
        describeActivity: () => this.#activity(),
        pauseRuns: () => this.#pauseRuns(),
        stopAllWork: () => this.#stopAllWork(),
        quit: options.quit,
      },
    });
  }

  get state(): IslandState {
    return this.#services.attention.state;
  }

  get visible(): boolean {
    return this.#window.visible;
  }

  async start(): Promise<void> {
    this.#tray.create();

    this.#unsubscribe = this.#services.attention.subscribe((state) => {
      this.#window.render(state);
      this.#tray.refresh();
    });

    // Anything that changes what the island should show also refreshes it.
    // Fire-and-forget refreshes must never reject unhandled: a failing
    // refresh is logged and the next tick retries.
    this.#eventsUnsubscribe = this.#services.events.subscribe(() =>
      this.refresh().catch((error: unknown) =>
        this.#services.logger.warn("Island refresh failed", {
          error: error instanceof Error ? error.message : String(error),
        }),
      ),
    );
    // Time passes too: an entry ages out and usage changes on its own.
    this.#timer = setInterval(
      () =>
        this.refresh().catch((error: unknown) =>
          this.#services.logger.warn("Island refresh failed", {
            error: error instanceof Error ? error.message : String(error),
          }),
        ),
      2_000,
    );
    this.#timer.unref?.();

    const settings = await this.#services.settings.get();
    // The window always learns the preferences, so showing it later works
    // even when it did not start visible with the app.
    this.#window.configure(settings.statusIsland);
    if (settings.statusIsland.enabled && settings.statusIsland.startWithApp) {
      this.#window.apply(settings.statusIsland);
    }
    await this.refresh();
  }

  /** Collects the current picture and lets the service decide (spec §102). */
  async refresh(): Promise<IslandState> {
    if (this.#refreshing) {
      this.#needsRefresh = true;
      return this.#services.attention.state;
    }
    this.#refreshing = true;
    let state: IslandState;
    try {
      state = await this.#refreshInner();
    } finally {
      this.#refreshing = false;
    }
    if (this.#needsRefresh) {
      this.#needsRefresh = false;
      return await this.refresh();
    }
    return state;
  }

  async #refreshInner(): Promise<IslandState> {
    const now = new Date();
    const runs = await this.#runSnapshots();

    const attention: Array<IslandSources["attention"][number]> = [];
    const errors: Array<IslandSources["errors"][number]> = [];
    const completed: Array<IslandSources["completed"][number]> = [];

    for (const snapshot of runs) {
      // An agent that asked for help is waiting on a person (spec §99).
      for (const message of snapshot.messages) {
        if (message.type === "question" && message.readAt === null) {
          attention.push({
            key: `msg:${message.id}`,
            title: `${message.from} needs your attention`,
            detail: message.content.slice(0, 120),
            runId: snapshot.run.id,
            at: message.timestamp,
          });
        }
      }
      for (const task of snapshot.tasks) {
        if (task.status === "failed" && task.error) {
          errors.push({
            key: `task:${task.id}`,
            title: task.title,
            detail: task.error.slice(0, 120),
            runId: snapshot.run.id,
            at: task.completedAt ?? task.createdAt,
          });
        }
      }
      if (snapshot.run.finishedAt && snapshot.run.status === "completed") {
        const total = snapshot.tasks.length;
        const done = snapshot.tasks.filter((task) => task.status === "completed").length;
        completed.push({
          key: `run:${snapshot.run.id}:done`,
          title: snapshot.run.goal,
          detail: total > 0 ? `${done} of ${total} tasks finished` : "Finished",
          runId: snapshot.run.id,
          at: snapshot.run.finishedAt,
        });
      }
    }

    const brokenConnections = this.#services.mcp
      .statuses()
      .filter((status) => status.state === "failed")
      .map((status) => ({
        key: `mcp:${status.id}`,
        title: `${status.name} is not connected`,
        detail: status.detail ?? "The server did not start",
      }));

    const busySessions = (await this.#services.sessions.list())
      .filter((session) => this.#services.sessions.isBusy(session.id))
      .map((session) => ({
        sessionId: session.id,
        name: session.name,
        // A solo session has no task graph, so its state is the honest
        // answer rather than a percentage (spec §103; §96 "Working").
        status: "working",
      }));

    const sortByNewest = <T extends { at: Date }>(entries: T[]): T[] =>
      entries.sort((left, right) => right.at.getTime() - left.at.getTime());

    // Tray counts come from the real lists, not from island entries (spec §104).
    this.#lastSessionCount = busySessions.length;
    this.#lastRunCount = runs.filter((snapshot) => snapshot.run.status === "running").length;

    return this.#services.attention.update({
      usage: await this.#services.usage.get(),
      runs,
      busySessions,
      attention: sortByNewest(attention),
      errors: sortByNewest(errors),
      completed: sortByNewest(completed),
      brokenConnections,
      now,
    });
  }

  async setPreferences(patch: Partial<IslandPreferences>): Promise<IslandState> {
    // Preference writes go through one chain so two concurrent callers (drag
    // position + settings screen) apply in order instead of interleaving.
    const run = this.#preferencesChain.then(() => this.#setPreferencesInner(patch));
    this.#preferencesChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async #setPreferencesInner(patch: Partial<IslandPreferences>): Promise<IslandState> {
    const settings = await this.#services.settings.update({
      statusIsland: { ...this.#services.attention.preferences, ...patch },
    });
    const state = this.#services.attention.setPreferences(settings.statusIsland);
    this.#window.apply(settings.statusIsland);
    this.#tray.refresh();
    return state;
  }

  async pin(widget: IslandWidgetId | null): Promise<IslandState> {
    return this.setPreferences({ pinnedWidget: widget });
  }

  async cycle(direction: 1 | -1): Promise<IslandState> {
    const state = this.#services.attention.cycle(direction);
    try {
      await this.#services.settings.update({
        statusIsland: this.#services.attention.preferences,
      });
    } catch (error) {
      this.#services.logger.warn("Could not persist island preferences", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return state;
  }

  dismiss(): IslandState {
    return this.#services.attention.dismissOverride();
  }

  show(): boolean {
    // An explicit show is the user's choice, not a side effect of the main
    // window coming back.
    this.#hiddenWithMain = false;
    this.#window.show();
    this.#tray.refresh();
    return this.#window.visible;
  }

  hide(): boolean {
    // An explicit hide is the user's choice and stays until shown again.
    this.#hiddenWithMain = false;
    this.#window.hide();
    this.#tray.refresh();
    return this.#window.visible;
  }

  /**
   * Follows the main window when the island was not asked to stay (spec §101).
   * A manually hidden island is never resurrected by this; only an island
   * that was hidden together with the main window comes back with it.
   */
  setMainVisible(visible: boolean): void {
    if (visible) {
      if (this.#hiddenWithMain) {
        this.#hiddenWithMain = false;
        this.#window.apply(this.#services.attention.preferences);
        this.#tray.refresh();
      }
      return;
    }
    if (this.#services.attention.preferences.stayVisibleWhenHidden) {
      return;
    }
    if (this.#window.visible) {
      this.#window.hide();
      this.#hiddenWithMain = true;
      this.#tray.refresh();
    }
  }

  /** Brings the main window forward, at the place the entry is about. */
  open(target: IslandTarget): boolean {
    const window = this.#options.focusMainWindow();
    if (!window || window.isDestroyed()) {
      return false;
    }
    try {
      window.webContents.send(ISLAND_NAVIGATE_CHANNEL, target);
    } catch (error) {
      this.#services.logger.warn("Could not navigate the main window", {
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
    this.dismiss();
    return true;
  }

  dispose(): void {
    this.#unsubscribe?.();
    this.#unsubscribe = null;
    this.#eventsUnsubscribe?.();
    this.#eventsUnsubscribe = null;
    if (this.#timer) {
      clearInterval(this.#timer);
      this.#timer = null;
    }
    this.#tray.destroy();
    this.#window.destroy();
  }

  async #runSnapshots(): Promise<
    Awaited<ReturnType<AppServices["teams"]["getSnapshot"]>>[]
  > {
    // Bound before filtering: the history can grow without bound, but only a
    // small window is ever snapshotted, so cap the raw list first and the
    // relevant subset second.
    const runs = (await this.#services.teams.listRuns()).slice(0, 50);
    const relevant = runs
      .filter((run) => run.status === "running" || run.finishedAt !== null)
      .slice(0, 10);
    const snapshots = await Promise.all(
      relevant.map((run) =>
        this.#services.teams.getSnapshot(run.id).catch(() => null),
      ),
    );
    return snapshots.filter((snapshot) => snapshot !== null);
  }

  #activity(): { sessions: number; runs: number } {
    return { sessions: this.#lastSessionCount, runs: this.#lastRunCount };
  }

  async #pauseRuns(): Promise<void> {
    const runs = await this.#services.teams.listRuns();
    for (const run of runs.filter((entry) => entry.status === "running")) {
      await this.#services.teams.pauseRun(run.id).catch(() => undefined);
    }
    await this.refresh();
  }

  async #stopAllWork(): Promise<void> {
    const runs = await this.#services.teams.listRuns();
    for (const run of runs.filter((entry) => entry.status === "running")) {
      await this.#services.teams.cancelRun(run.id).catch(() => undefined);
    }
    for (const session of await this.#services.sessions.list()) {
      if (this.#services.sessions.isBusy(session.id)) {
        await this.#services.sessions.cancel(session.id).catch(() => undefined);
      }
    }
    await this.refresh();
  }
}
