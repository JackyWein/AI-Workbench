import type { BrowserWindow } from "electron";
import {
  ISLAND_NAVIGATE_CHANNEL,
  type IslandPreferences,
  type IslandState,
  type IslandTarget,
  type IslandWidgetId,
  type TerminalAttentionResponse,
} from "@ai-workbench/shared";
import type { IslandSources } from "@ai-workbench/status";
import type { AppServices } from "./services.js";
import { StatusIslandWindow } from "./status-island.js";
import { StatusTray } from "./tray.js";
import { metricsLine } from "./island-helpers.js";

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
  /**
   * Side-effect-free read of the main window for visibility/focus checks.
   * Unlike focusMainWindow, calling this never shows or focuses anything.
   */
  readonly getMainWindow: () => BrowserWindow | null;
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
  /**
   * When each chat or shell was first seen busy. Those report no start time
   * of their own, so the island's clock runs from the moment it was observed
   * (within one refresh) rather than restarting on every refresh.
   */
  readonly #busySince = new Map<string, Date>();
  /** Whether each provider is installed, checked at most once a minute. */
  readonly #installed = new Map<string, { installed: boolean; at: number }>();
  /** Where each listed agent can take a typed prompt, by its island key. */
  #askTargets = new Map<string, { terminalId: string } | { sessionId: string }>();
  /** Which tile's request each answerable island entry is, by its key. */
  #respondTargets = new Map<
    string,
    { tileId: string; attentionId: string; kind: "permission" | "question" }
  >();
  /** True while the island is hidden only because the main window is. */
  #hiddenWithMain = false;
  /** Whether the main window currently holds focus. */
  #mainFocused = false;
  /**
   * Set by an explicit hide; while true, focus changes must not resurrect the
   * island. Cleared by an explicit show or by re-enabling the island.
   */
  #manualHidden = false;
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
      onSettle: (settle) => {
        // A dragged island keeps where it was left, across restarts (spec
        // §95): docked at its spot on a rail, or free where it was dropped.
        const patch: Partial<IslandPreferences> = settle.dockedEdge
          ? { dockedEdge: settle.dockedEdge, railT: settle.railT, displayId: settle.displayId }
          : {
              dockedEdge: null,
              railT: null,
              position: "custom",
              customX: settle.x,
              customY: settle.y,
              displayId: settle.displayId,
            };
        void this.setPreferences(patch).catch((error: unknown) =>
          this.#services.logger.warn("Could not keep where the island was dragged", {
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
        toggleIsland: () => this.toggleIsland(),
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
    // From the first second the focus rule governs: a focused main window
    // means no island on top of it. Reads focus without touching the window:
    // focusMainWindow would show and focus it as a side effect.
    const main = this.#options.getMainWindow();
    this.setMainFocused(Boolean(main && !main.isDestroyed() && main.isFocused()));
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
    const questions: Array<IslandSources["questions"][number]> = [];
    const errors: Array<IslandSources["errors"][number]> = [];
    const completed: Array<IslandSources["completed"][number]> = [];

    const iconOf = (providerId: string | null | undefined): string | null =>
      providerId ? (this.#services.providers.get(providerId)?.metadata.icon ?? null) : null;

    // A message names its sender by agent id, which means nothing to a person;
    // the island says who is asking by the name the team gave that agent, and
    // shows the mark of the tool that agent runs on.
    const agentNames = new Map<string, string>();
    const agentIcons = new Map<string, string | null>();
    for (const teamId of new Set(runs.map((snapshot) => snapshot.run.teamId))) {
      const team = await this.#services.teams.get(teamId).catch(() => null);
      for (const agent of team?.agents ?? []) {
        agentNames.set(agent.id, agent.displayName);
        agentIcons.set(agent.id, iconOf(agent.providerId));
      }
    }

    for (const snapshot of runs) {
      // An agent that asked for help is waiting on a person (spec §99).
      for (const message of snapshot.messages) {
        if (message.type === "question" && message.readAt === null) {
          attention.push({
            key: `msg:${message.id}`,
            title: `${agentNames.get(message.from) ?? message.from} needs your attention`,
            detail: message.content.slice(0, 120),
            runId: snapshot.run.id,
            icon: agentIcons.get(message.from) ?? null,
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
            icon: task.assignedTo ? (agentIcons.get(task.assignedTo) ?? null) : null,
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

    const sessions = await this.#services.sessions.list();
    const seenBusy = new Set<string>();
    const since = (key: string): Date => {
      seenBusy.add(key);
      const known = this.#busySince.get(key);
      if (known) {
        return known;
      }
      this.#busySince.set(key, now);
      return now;
    };
    const askTargets = new Map<string, { terminalId: string } | { sessionId: string }>();
    const respondTargets = new Map<
      string,
      { tileId: string; attentionId: string; kind: "permission" | "question" }
    >();
    const busySessions: Array<IslandSources["busySessions"][number]> = sessions
      .filter((session) => this.#services.sessions.isBusy(session.id))
      .map((session) => ({
        sessionId: session.id,
        name: session.name,
        // A solo session has no task graph, so its state is the honest
        // answer rather than a percentage (spec §103; §96 "Working").
        status: "working",
        startedAt: since(`session:${session.id}`),
        icon: iconOf(session.providerId),
      }));
    for (const session of busySessions) {
      askTargets.set(`session:${session.sessionId}`, { sessionId: session.sessionId });
    }

    // Agent tiles and plain shells are live work too: without them the island
    // sits on usage while the user visibly works in terminals (spec §95).
    // Tile ptys are excluded from the shell list below so nothing counts twice.
    const tileTerminalIds = new Set<string>();
    /** Agents whose tool said it is idle at its prompt: resting, not at work. */
    const restingTiles: Array<IslandSources["sessions"][number]> = [];
    try {
      const workspaces = await this.#services.workspaces.list();
      for (const workspace of workspaces) {
        const tiles = await this.#services.agentTerminals
          .list(workspace.id)
          .catch(() => []);
        for (const tile of tiles) {
          if (tile.state !== "running") {
            continue;
          }
          if (tile.terminalId) {
            tileTerminalIds.add(tile.terminalId);
          }
          const key = `tile:${tile.id}`;
          if (tile.terminalId && tile.purpose === "agent") {
            askTargets.set(key, { terminalId: tile.terminalId });
          }
          // Working and idle are what the tool itself reported (spec §103). A
          // tool that reports neither is only known to be running, and says so
          // instead of claiming work.
          const activity = tile.purpose === "agent" ? tile.activity : null;
          const waiting = tile.purpose === "agent" ? tile.attention : null;
          if (activity?.state === "idle" && !waiting) {
            restingTiles.push({
              name: tile.label,
              icon: iconOf(tile.providerId),
              lastActiveAt: activity.since,
              busy: false,
            });
          } else {
            const status =
              tile.purpose === "login"
                ? "signing in"
                : tile.purpose === "setup"
                  ? "setting up"
                  : tile.purpose === "shell"
                  ? "shell"
                  : activity?.state === "working"
                    ? "working"
                    : "running";
            busySessions.push({
              key,
              sessionId: tile.id,
              name: tile.label,
              status,
              target: { view: "chat" },
              // A turn's clock runs from when the tool started on it.
              startedAt: activity?.state === "working" ? activity.since : tile.startedAt,
              icon: iconOf(tile.providerId),
              detail: (tile.metrics ? metricsLine(tile.metrics) : "") || status,
            });
          }
          // The tool itself said it waits on the person (spec §99): the
          // island shows it with that tool's mark, and offers the answers the
          // tool takes from outside its terminal.
          if (waiting) {
            const attentionKey = `tile:${tile.id}:${waiting.id}`;
            if (waiting.answerable) {
              respondTargets.set(attentionKey, {
                tileId: tile.id,
                attentionId: waiting.id,
                kind: waiting.kind,
              });
            }
            if (waiting.kind === "question") {
              questions.push({
                key: attentionKey,
                title: waiting.summary || `${tile.label} has a question`,
                detail: tile.label,
                icon: iconOf(tile.providerId),
                options: waiting.answerable ? waiting.choices : [],
                target: { view: "chat" },
                at: waiting.since,
              });
            } else {
              attention.push({
                key: attentionKey,
                title: `${tile.label} wants to use ${waiting.tool ?? "a tool"}`,
                detail: waiting.summary,
                target: { view: "chat" },
                icon: iconOf(tile.providerId),
                options: waiting.answerable
                  ? [
                      { id: "deny", label: "Deny" },
                      { id: "allow", label: "Allow" },
                    ]
                  : [],
                at: waiting.since,
              });
            }
          }
        }
      }
    } catch (error) {
      this.#services.logger.debug("Island could not list agent terminals", {
        error: error instanceof Error ? error.message : String(error),
      });
    }

    try {
      const names = new Map(sessions.map((session) => [session.id, session.name]));
      for (const info of this.#services.terminals.list()) {
        if (tileTerminalIds.has(info.id)) {
          continue;
        }
        busySessions.push({
          key: `terminal:${info.id}`,
          sessionId: info.sessionId,
          name: names.get(info.sessionId) ?? "Shell",
          status: "in terminal",
          target: { view: "chat", sessionId: info.sessionId },
          startedAt: since(`terminal:${info.id}`),
        });
      }
    } catch (error) {
      this.#services.logger.debug("Island could not list terminals", {
        error: error instanceof Error ? error.message : String(error),
      });
    }

    // Work that stopped forgets its start; the next run starts a new clock.
    for (const key of this.#busySince.keys()) {
      if (!seenBusy.has(key)) {
        this.#busySince.delete(key);
      }
    }

    const sortByNewest = <T extends { at: Date }>(entries: T[]): T[] =>
      entries.sort((left, right) => right.at.getTime() - left.at.getTime());

    // Tray counts come from the real lists, not from island entries (spec §104).
    this.#lastSessionCount = busySessions.length;
    this.#lastRunCount = runs.filter((snapshot) => snapshot.run.status === "running").length;

    this.#askTargets = askTargets;
    this.#respondTargets = respondTargets;

    // Usage rows follow the providers the user sees: enabled ones, and the
    // simulated one only for developers.
    const settings = await this.#services.settings.get();
    const usage = await this.#services.usage.get();
    const installed = new Set<string>();
    await Promise.all(
      (usage?.snapshots ?? []).map(async (snapshot) => {
        if (await this.#isInstalled(snapshot.providerId)) {
          installed.add(snapshot.providerId);
        }
      }),
    );
    const providers = (usage?.snapshots ?? []).flatMap((snapshot) => {
      const adapter = this.#services.providers.get(snapshot.providerId);
      if (
        !adapter ||
        !installed.has(snapshot.providerId) ||
        !this.#services.providers.isProviderEnabled(snapshot.providerId)
      ) {
        return [];
      }
      const simulated = adapter.metadata.transportTypes.every((type) => type === "in-process");
      if (simulated && !settings.developerMode) {
        return [];
      }
      return [
        {
          id: snapshot.providerId,
          name: adapter.metadata.displayName,
          icon: adapter.metadata.icon ?? null,
        },
      ];
    });

    const sessionRows = [
      ...sessions.map((session) => ({
        name: session.name,
        icon: iconOf(session.providerId),
        lastActiveAt: session.updatedAt,
        busy: this.#services.sessions.isBusy(session.id),
      })),
      ...restingTiles,
    ];

    // The snapshots follow the same filter as the names. Handing over every
    // snapshot while the list of providers came out empty would let the
    // widget fall back to naming rows by id — and show the simulated provider
    // after all, but only on a machine where no real tool is installed.
    const visible = new Set(providers.map((provider) => provider.id));
    const shownUsage = usage
      ? { ...usage, snapshots: usage.snapshots.filter((snapshot) => visible.has(snapshot.providerId)) }
      : usage;

    return this.#services.attention.update({
      usage: shownUsage,
      runs,
      busySessions,
      providers,
      sessions: sessionRows,
      attention: sortByNewest(attention),
      questions: sortByNewest(questions),
      errors: sortByNewest(errors),
      completed: sortByNewest(completed),
      brokenConnections,
      now,
    });
  }

  /** A tool that is not installed gets no usage row, not even "unavailable". */
  async #isInstalled(providerId: string): Promise<boolean> {
    const known = this.#installed.get(providerId);
    if (known && Date.now() - known.at < 60_000) {
      return known.installed;
    }
    const adapter = this.#services.providers.get(providerId);
    let installed = false;
    try {
      installed = (await adapter?.detectInstallation())?.state === "installed";
    } catch {
      installed = false;
    }
    this.#installed.set(providerId, { installed, at: Date.now() });
    return installed;
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
    const wasEnabled = this.#services.attention.preferences.enabled;
    const settings = await this.#services.settings.update({
      statusIsland: { ...this.#services.attention.preferences, ...patch },
    });
    if (patch.enabled === false) {
      this.#manualHidden = true;
    } else if (patch.enabled === true && !wasEnabled) {
      // Re-enabling is an explicit show: back on screen, focus rule after.
      this.#manualHidden = false;
    }
    const state = this.#services.attention.setPreferences(settings.statusIsland);
    this.#window.apply(settings.statusIsland);
    this.#tray.refresh();
    return state;
  }

  async pin(widget: IslandWidgetId | null): Promise<IslandState> {
    // Pinning — including going back to automatic — is an explicit choice, so
    // the entry holding the island lets go first (spec §100). Writing the
    // preference alone would leave a passing announcement on screen and the
    // choice would look like it had not been taken.
    this.#services.attention.pin(widget);
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

  /**
   * Types a prompt into the agent the island lists under `key`, falling back
   * to the first running agent terminal. A chat session that is mid-answer
   * cannot take a message, and the answer says so instead of dropping it.
   */
  async ask(
    key: string,
    text: string,
  ): Promise<{ sent: boolean; to: string | null; reason: string | null }> {
    const nameOf = (targetKey: string): string | null =>
      this.#services.attention.state.entries
        .flatMap((entry) => entry.agents)
        .find((row) => row.key === targetKey)?.title ?? null;
    const direct = this.#askTargets.get(key);
    const fallback = [...this.#askTargets.entries()].find(([, target]) => "terminalId" in target);
    const [targetKey, target] =
      direct && "terminalId" in direct ? [key, direct] : (fallback ?? [key, direct]);
    if (!target) {
      return { sent: false, to: null, reason: "No running agent can take a prompt" };
    }
    if ("sessionId" in target) {
      return {
        sent: false,
        to: nameOf(targetKey),
        reason: "Still answering; ask again when it finishes",
      };
    }
    this.#services.terminals.write(target.terminalId, text);
    // Enter goes separately, so a tool reading the text as a paste still
    // submits it instead of taking the return as a new line.
    await new Promise((resolve) => setTimeout(resolve, 40));
    this.#services.terminals.write(target.terminalId, "\r");
    return { sent: true, to: nameOf(targetKey), reason: null };
  }

  /**
   * Answers what an agent on the island waits on, in place: Allow or Deny for
   * a permission, one of its choices for a question. The tool decides whether
   * it takes the answer; its own prompt in its terminal stays usable.
   */
  async respond(key: string, option: string): Promise<{ answered: boolean; reason: string | null }> {
    const target = this.#respondTargets.get(key);
    if (!target) {
      return { answered: false, reason: "It is no longer waiting" };
    }
    let response: TerminalAttentionResponse;
    if (target.kind === "permission") {
      if (option !== "allow" && option !== "deny") {
        return { answered: false, reason: "That is not an answer to a permission" };
      }
      response = { decision: option };
    } else {
      response = { choice: option };
    }
    const answered = await this.#services.agentTerminals.respond(
      target.tileId,
      target.attentionId,
      response,
    );
    await this.refresh().catch(() => undefined);
    return {
      answered,
      reason: answered ? null : "It is no longer waiting; answer it in its terminal",
    };
  }

  /** Forgets a dragged spot and edge-dock, back to the default corner. */
  resetPosition(): Promise<IslandState> {
    return this.setPreferences({
      position: "topCenter",
      customX: null,
      customY: null,
      displayId: null,
      dockedEdge: null,
      railT: null,
    });
  }

  /** The island page grabbed its unit; the window follows the pointer. */
  beginDrag(grabX: number, grabY: number): { dragging: boolean } {
    return { dragging: this.#window.beginDrag(grabX, grabY) };
  }

  /** The island page let go; the unit settles and its spot is kept. */
  endDrag(): { dragging: boolean } {
    return { dragging: this.#window.endDrag() };
  }

  /** Applies the size the island page measured for its current face. */
  resize(width: number, height: number): boolean {
    this.#window.setContentSize(width, height);
    return this.#window.visible;
  }

  show(): boolean {
    // An explicit show wins immediately; focus changes govern after it.
    this.#manualHidden = false;
    this.#hiddenWithMain = false;
    this.#window.show();
    this.#tray.refresh();
    return this.#window.visible;
  }

  hide(): boolean {
    // An explicit hide sticks until an explicit show or re-enable: focus
    // changes must not resurrect what the user dismissed.
    this.#manualHidden = true;
    this.#hiddenWithMain = false;
    this.#window.hide();
    this.#tray.refresh();
    return this.#window.visible;
  }

  /** Tray toggle with the same stickiness as the IPC show/hide. */
  toggleIsland(): boolean {
    if (this.#window.visible) {
      this.hide();
    } else {
      this.show();
    }
    return this.#window.visible;
  }

  /**
   * The island belongs on screen from launch, but never on top of the app
   * itself: a focused main window hides it, losing focus brings it back.
   * Explicit choices (manual hide, disabled island) always win over this.
   */
  setMainFocused(focused: boolean): void {
    this.#mainFocused = focused;
    this.#applyFocusRule();
  }

  #applyFocusRule(): void {
    const preferences = this.#services.attention.preferences;
    if (!preferences.enabled || this.#manualHidden) {
      return;
    }
    if (this.#mainFocused) {
      if (this.#window.visible) {
        this.#window.hide();
        this.#tray.refresh();
        this.#services.logger.info("Island hidden while the main window is focused");
      }
      return;
    }
    // Focus went elsewhere (or nowhere): the island comes back — unless the
    // main window itself is gone and the user asked it not to outlive it.
    // Reads through getMainWindow on purpose: focusMainWindow would restore
    // and focus the window as a side effect, which un-minimizes it.
    const main = this.#options.getMainWindow();
    const mainGone = !main || main.isDestroyed() || !main.isVisible();
    if (mainGone && !preferences.stayVisibleWhenHidden) {
      if (this.#window.visible) {
        this.#window.hide();
        this.#tray.refresh();
        this.#services.logger.info("Island hidden with the main window");
      }
      return;
    }
    if (!this.#window.visible) {
      this.#window.show();
      this.#tray.refresh();
      this.#services.logger.info("Island shown while the main window is in the background");
    }
  }

  /**
   * Follows the main window when the island was not asked to stay (spec §101).
   * A manually hidden island is never resurrected by this; only an island
   * that was hidden together with the main window comes back with it — and
   * only when the focus rule would show it anyway.
   */
  setMainVisible(visible: boolean): void {
    if (visible) {
      if (this.#hiddenWithMain) {
        this.#hiddenWithMain = false;
        this.#applyFocusRule();
        this.#tray.refresh();
      }
      return;
    }
    // A hidden window is not in front any more, but hiding it does not blur
    // it on Windows: without this the island would still think the app is
    // focused and stay hidden after closing to the tray.
    this.#mainFocused = false;
    if (this.#services.attention.preferences.stayVisibleWhenHidden) {
      this.#applyFocusRule();
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
