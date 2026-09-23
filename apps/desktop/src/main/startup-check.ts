import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { BrowserWindow, screen } from "electron";
import { execCli } from "@ai-workbench/transport-cli";
import type { Logger } from "@ai-workbench/shared";
import type { startSshTestServer as StartSshTestServer } from "@ai-workbench/test-support";
import type { IslandController } from "./island-controller.js";

export interface CheckOutcome {
  readonly name: string;
  readonly passed: boolean;
  readonly detail: string;
}

export interface StartupCheckResult {
  readonly healthy: boolean;
  readonly outcomes: CheckOutcome[];
}

/**
 * Headless verification of a real application start, used by `bun run verify:app`
 * and by CI where no display is available.
 *
 * It drives the actual renderer — the same preload bridge, IPC contract and
 * React tree a user gets — so that entries in PROGRESS.md rest on something
 * that was executed rather than on an assumption. It runs against a throwaway
 * user-data directory, never the user's own database.
 */
export type StartupCheckMode = "create" | "resume";

export async function runStartupCheck(
  window: BrowserWindow,
  logger: Logger,
  options: {
    workspaceDirectory: string;
    mode: StartupCheckMode;
    island: IslandController;
  },
): Promise<StartupCheckResult> {
  const { workspaceDirectory, mode, island } = options;
  const repository = await seedWorkspace(workspaceDirectory);
  const rendererErrors: string[] = [];
  window.webContents.on("console-message", (event) => {
    if (event.level === "error") {
      rendererErrors.push(event.message);
    }
  });

  await once(window, "did-finish-load");

  const outcomes: CheckOutcome[] = [];
  const check = async (
    name: string,
    script: string,
    timeoutMs = 30_000,
  ): Promise<boolean> => {
    // The timeout timer is cleared on every path: a check that passed must
    // not keep a pending rejection alive behind it.
    let timer: NodeJS.Timeout | undefined;
    try {
      // A check that never settles would hang the whole verification with no
      // output at all, which is worse than a failure.
      const value: unknown = await Promise.race([
        window.webContents.executeJavaScript(script),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new Error(`timed out after ${timeoutMs}ms`)),
            timeoutMs,
          );
        }),
      ]);
      const passed = value === true || (typeof value === "number" && value > 0);
      outcomes.push({ name, passed, detail: String(value) });
      return passed;
    } catch (error) {
      outcomes.push({
        name,
        passed: false,
        detail: error instanceof Error ? error.message : String(error),
      });
      return false;
    } finally {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
    }
  };

  /**
   * A check against the main process itself — the island window's bounds and
   * visibility, which the renderer cannot observe — recorded like the rest.
   */
  const checkMain = async (
    name: string,
    run: () => boolean | Promise<boolean>,
  ): Promise<boolean> => {
    try {
      const value = await run();
      outcomes.push({ name, passed: value === true, detail: String(value) });
      return value === true;
    } catch (error) {
      outcomes.push({
        name,
        passed: false,
        detail: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  };

  /** The island's own window, identified by the page it loads. */
  const islandWindow = (): BrowserWindow | null =>
    BrowserWindow.getAllWindows().find(
      (entry) =>
        !entry.isDestroyed() &&
        entry.webContents.getURL().endsWith("island/index.html"),
    ) ?? null;

  const islandJs = async (script: string): Promise<unknown> => {
    const target = islandWindow();
    if (!target) {
      throw new Error("the island window does not exist");
    }
    return target.webContents.executeJavaScript(script);
  };

  /** Dispatches a key the island page handles itself (spec §100). */
  const pressIslandKey = async (key: string): Promise<boolean> => {
    try {
      const pressed = await islandJs(
        `(() => {
           const node = document.querySelector('.isl');
           if (!node) return false;
           node.dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(key)}, bubbles: true }));
           return true;
         })()`,
      );
      await new Promise((resolve) => setTimeout(resolve, 500));
      return pressed === true;
    } catch {
      return false;
    }
  };

  /** Waits until the island page renders a real unit, not its loading face. */
  const waitIslandDom = async (timeoutMs = 10_000): Promise<boolean> => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        const ready = await islandJs(
          `(() => {
             const label = document.querySelector('.isl')?.getAttribute('aria-label') ?? '';
             return Boolean(label && !label.includes('loading') && !label.includes('No state'));
           })()`,
        );
        if (ready === true) {
          return true;
        }
      } catch {
        // The page is still loading; keep waiting.
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    return false;
  };

  await check(
    "shell renders",
    `(async () => {
       // The boot screen gates the shell until the store is ready, so this
       // waits for the app rather than asserting a single frame.
       const deadline = Date.now() + 15000;
       while (Date.now() < deadline) {
         if (document.querySelector('.app') && document.querySelector('.sidebar')) {
           return true;
         }
         await new Promise(resolve => setTimeout(resolve, 100));
       }
       return false;
     })()`,
  );

  await check(
    "preload bridge reaches the provider registry",
    "window.workbench.invoke('provider.list', undefined).then(list => list.length)",
  );

  // The full first vertical slice, driven through the same API the UI uses.
  await check(
    mode === "create"
      ? "workspace, session, streamed answer and usage"
      : "conversation and provider session survived the restart",
    mode === "create" ? createScenario(workspaceDirectory) : resumeScenario(),
  );

  // --- status island: enable, window, preferences ---------------------------

  await check(
    "the island turns on and reports the mocked usage",
    `(async () => {
       const api = window.workbench;
       // The simulated provider is a developer's tool, so its usage reaches the
       // island only in developer mode — on every machine, whether or not a
       // real tool happens to be installed next to it.
       await api.invoke('settings.update', { developerMode: false });
       const plain = await api.invoke('statusIsland.setPreferences', {
         enabled: true,
         autoExpand: true,
       });
       if (!plain.preferences.enabled) return false;
       if (plain.entries.some(entry => entry.widget === 'providerUsage'
         && /Mock/.test(entry.title ?? ''))) {
         return 'the simulated provider showed outside developer mode';
       }
       await api.invoke('settings.update', { developerMode: true });
       const state = await api.invoke('statusIsland.getState', undefined);
       return state.entries.some(entry => entry.widget === 'providerUsage'
           && /Mock Provider \\d+%/.test(entry.title ?? ''))
         && state.entries.every((entry, index, all) =>
           index === 0 || all[index - 1].priority >= entry.priority);
     })()`,
  );

  await checkMain("the island is a separate visible window", async () => {
    // The island hides while the main window is focused, so the check looks
    // away first: losing focus is what brings it on screen.
    window.blur();
    const deadline = Date.now() + 5_000;
    let visible = false;
    while (Date.now() < deadline) {
      if (island.visible) {
        visible = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    if (!visible) {
      return false;
    }
    if (!(await waitIslandDom())) {
      return false;
    }
    const target = islandWindow();
    if (!target || !target.isVisible()) {
      return false;
    }
    // Two windows with their own pages: the main window and the island.
    if (BrowserWindow.getAllWindows().filter((entry) => !entry.isDestroyed()).length !== 2) {
      return false;
    }
    // It names what the service reported — nothing invented — and it is sized
    // for its face: the page measures, main sizes the window to it. Which
    // face that is depends on what the application knows, so the label is
    // compared against the service rather than a fixed value. On a second
    // start there can be unseen news, so a check that demanded one face would
    // be asserting a fresh profile.
    const state = island.state;
    const label = await islandJs(
      "document.querySelector('.isl')?.getAttribute('aria-label') ?? ''",
    );
    const bounds = target.getBounds();
    const names = state.entries.map((entry) => entry.title);
    const sized =
      bounds.width >= 42 &&
      bounds.width <= 480 &&
      bounds.height >= 42 &&
      bounds.height <= 640;
    return (
      typeof label === "string" &&
      label.startsWith("Status Island:") &&
      (names.some((name) => label.includes(name)) ||
        label.includes(state.current.title) ||
        label.includes("No agents")) &&
      sized
    );
  });

  // By default the island stays on screen from launch, focused app or not.
  await checkMain("the island stays on while the main window is focused", async () => {
    focusWindow(window);
    await new Promise((resolve) => setTimeout(resolve, 2_500));
    return island.visible;
  });

  await checkMain("the island hides while the main window is focused", async () => {
    // Opt-in behavior (hideWhenMainFocused): only asserted when enabled.
    await island.setPreferences({
      hideWhenMainFocused: true,
    });
    focusWindow(window);
    const deadline = Date.now() + 5_000;
    let hidden = false;
    while (Date.now() < deadline) {
      if (!island.visible) {
        hidden = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    await island.setPreferences({
      hideWhenMainFocused: false,
    });
    // Give the show path a moment before the next check blurs again.
    await new Promise((resolve) => setTimeout(resolve, 300));
    return hidden;
  });

  await checkMain("the island returns when focus leaves the app", async () => {
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      // Asked for again on every round: without a window manager (Xvfb in
      // CI) a focus event left over from the step before can arrive after
      // the blur and take the focus back, which failed this once in CI.
      window.blur();
      await new Promise((resolve) => setTimeout(resolve, 200));
      if (island.visible) {
        return true;
      }
    }
    return false;
  });

  await check(
    "the island hides and shows on request",
    `(async () => {
       const hidden = await window.workbench.invoke('statusIsland.hide', undefined);
       const shown = await window.workbench.invoke('statusIsland.show', undefined);
       return hidden.visible === false && shown.visible === true;
     })()`,
  );

  await checkMain("showing the island brings its window back", () => {
    const target = islandWindow();
    return Boolean(target && target.isVisible() && island.visible);
  });

  // Least privilege per window (spec §5): the floating page reaches the
  // island channels and nothing else, while the main window keeps the full
  // contract.
  await checkMain("the island page carries only its own bridge", async () => {
    const workbench = await islandJs("typeof window.workbench");
    const islandBridge = await islandJs("typeof window.workbenchIsland");
    return workbench === "undefined" && islandBridge === "object";
  });

  await check(
    "island preferences round-trip through settings",
    `(async () => {
       const state = await window.workbench.invoke('statusIsland.setPreferences', {
         position: 'topRight',
         defaultWidget: 'activeAgents',
         autoRotateSeconds: 0,
         alwaysOnTop: true,
         startWithApp: true,
         stayVisibleWhenHidden: true,
         closeToTray: true,
         enabledWidgets: ['needsAttention', 'activeAgents', 'teamProgress',
           'providerUsage', 'completedWork', 'errors', 'connectionHealth'],
       });
       const settings = await window.workbench.invoke('settings.get', undefined);
       const prefs = state.preferences;
       const stored = settings.statusIsland;
       return prefs.position === 'topRight' && stored.position === 'topRight'
         && prefs.defaultWidget === 'activeAgents' && stored.defaultWidget === 'activeAgents'
         && prefs.closeToTray === true && stored.closeToTray === true
         && prefs.stayVisibleWhenHidden === true && stored.stayVisibleWhenHidden === true
         && stored.enabledWidgets.includes('connectionHealth');
     })()`,
  );

  // A configured position is only a claim until the window sits there.
  await check(
    "the island takes a custom position",
    `(async () => {
       const state = await window.workbench.invoke('statusIsland.setPreferences', {
         position: 'custom',
         customX: 200,
         customY: 150,
       });
       return state.preferences.position === 'custom'
         && state.preferences.customX === 200
         && state.preferences.customY === 150;
     })()`,
  );

  await checkMain("the island window sits at the custom position", async () => {
    // Pinned to the primary display, so the cursor's monitor cannot move the
    // goalposts on a multi-monitor desk.
    const primary = screen.getPrimaryDisplay();
    await island.setPreferences({
      position: "custom",
      customX: 200,
      customY: 150,
      displayId: primary.id,
    });
    const target = islandWindow();
    if (!target || !target.isVisible()) {
      return false;
    }
    const bounds = target.getBounds();
    const area = primary.workArea;
    const expectedX = Math.min(Math.max(200, area.x), area.x + area.width - bounds.width);
    const expectedY = Math.min(Math.max(150, area.y), area.y + area.height - bounds.height);
    return bounds.x === expectedX && bounds.y === expectedY;
  });

  if (mode === "resume") {
    // The create phase left the island enabled at a custom position, with
    // finished runs and unanswered questions behind it.
    await check(
      "island preferences and position survived the restart",
      `(async () => {
         const settings = await window.workbench.invoke('settings.get', undefined);
         const prefs = settings.statusIsland;
         return prefs.enabled === true
           && prefs.position === 'custom'
           && prefs.customX === 200
           && prefs.customY === 150;
       })()`,
    );

    await checkMain("the island reappears at the stored position", async () => {
      // A focused main window keeps the island hidden, so the check looks
      // away first — then the island must be back, at its stored spot.
      window.blur();
      const deadline = Date.now() + 5_000;
      let visible = false;
      while (Date.now() < deadline) {
        if (island.visible) {
          visible = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
      if (!visible) {
        return false;
      }
      if (!(await waitIslandDom())) {
        return false;
      }
      const target = islandWindow();
      if (!target || !target.isVisible()) {
        return false;
      }
      // Stored coordinates are clamped into the display, so the check
      // computes the same clamped position rather than assuming 200,150 is
      // fully visible (taskbars and multi-monitor offsets move it).
      const primary = screen.getPrimaryDisplay();
      const bounds = target.getBounds();
      const area = primary.workArea;
      const expectedX = Math.min(Math.max(200, area.x), area.x + area.width - bounds.width);
      const expectedY = Math.min(Math.max(150, area.y), area.y + area.height - bounds.height);
      return bounds.x === expectedX && bounds.y === expectedY;
    });

    await check(
      "completed work and attention are still reported",
      `(async () => {
         const api = window.workbench;
         const state = await api.invoke('statusIsland.getState', undefined);

         // An unread question is a state: it lasts until somebody reads it,
         // so it has to survive a restart.
         if (!state.entries.some(item => item.widget === 'needsAttention')) {
           return 'no attention entry';
         }
         if (!state.entries.every((entry, index, all) =>
           index === 0 || all[index - 1].priority >= entry.priority)) {
           return 'entries are out of order';
         }

         // A finished run is news, and news ages out on purpose (spec §97).
         // Whether it should still be on the island therefore depends on how
         // long ago it finished, not on it having happened at all.
         const runs = await api.invoke('team.listRuns', {});
         const finished = runs
           .filter(run => run.status === 'completed' && run.finishedAt)
           .map(run => new Date(run.finishedAt).getTime());
         if (finished.length === 0) return 'no completed run survived';
         const newest = Math.max(...finished);
         const isNews = Date.now() - newest < 5 * 60 * 1000;
         const reported = state.entries.some(item => item.widget === 'completedWork');
         return reported === isNews
           ? true
           : 'completed work ' + (reported ? 'reported' : 'missing')
             + ' but the run finished ' + Math.round((Date.now() - newest) / 1000) + 's ago';
       })()`,
    );
  }

  // A session created outside the UI is not auto-selected, so the check opens
  // it the way a user does: by clicking the workspace in the sidebar.
  await check(
    "selecting the workspace shows its conversation",
    `(async () => {
       const row = [...document.querySelectorAll('.sidebar__scroll .row')]
         .find(node => node.textContent?.includes('Check workspace'));
       if (!row) return false;
       row.click();
       return ${waitFor("document.querySelectorAll('.message').length >= 2")};
     })()`,
  );

  await check(
    "command palette opens with Ctrl+K",
    `(() => {
       window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true }));
       return new Promise(resolve => setTimeout(
         () => resolve(Boolean(document.querySelector('.palette'))), 60));
     })()`,
  );

  await check(
    "command palette closes with Escape",
    `(() => {
       const input = document.querySelector('.palette__input');
       input?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
       return new Promise(resolve => setTimeout(
         () => resolve(document.querySelector('.palette') === null), 60));
     })()`,
  );

  // Chromium only dispatches focus events to a page that has focus itself. A
  // headless display has no window manager to hand it over, so the check asks
  // for it explicitly rather than depending on whatever had focus before.
  focusWindow(window);
  await check(
    "usage pill opens the usage view",
    `(() => {
       const trigger = document.querySelector('.header__actions .usage-pill');
       if (!trigger) return false;
       trigger.click();
       return ${waitFor(
         "[...document.querySelectorAll('.view__title')].some(node => node.textContent === 'Usage')",
         2000,
       )};
     })()`,
  );

  await check(
    "settings view opens from the sidebar",
    `(() => {
       const rows = [...document.querySelectorAll('.sidebar__foot .row')];
       rows.find(row => row.textContent?.includes('Settings'))?.click();
       return new Promise(resolve => setTimeout(
         () => resolve(Boolean([...document.querySelectorAll('.view__title')]
           .some(node => node.textContent === 'Settings'))), 120));
     })()`,
  );

  await check(
    "providers view lists the registered adapters",
    `(() => {
       const rows = [...document.querySelectorAll('.sidebar__foot .row')];
       rows.find(row => row.textContent?.includes('Providers'))?.click();
       return new Promise(resolve => setTimeout(
         () => resolve(document.querySelectorAll('.provider-entry').length), 120));
     })()`,
  );

  // A tool with a further account shows an accounts section. On a person's
  // own machine that is common (any ~/.codex-* or ~/.claude-* home counts),
  // in a fresh check it never is, which is how a render loop there went
  // unnoticed and left the whole screen unusable.
  await check(
    "the providers view stays up for a tool with a further account",
    `(async () => {
       const account = await window.workbench.invoke('account.add', {
         family: 'codex',
         label: 'Startup check',
       });
       const open = async (name) => {
         const rows = [...document.querySelectorAll('.sidebar__foot .row')];
         rows.find(row => row.textContent?.includes(name))?.click();
         await new Promise(resolve => setTimeout(resolve, 150));
       };
       try {
         // Opened afresh, so the screen reads the accounts again.
         await open('Settings');
         await open('Providers');
         await new Promise(resolve => setTimeout(resolve, 1500));
         const entries = document.querySelectorAll('.provider-entry').length;
         const broken = [...document.querySelectorAll('.view__title')]
           .some(node => node.textContent?.includes('unavailable'));
         const accounts = [...document.querySelectorAll('.provider-row__subtitle')]
           .some(node => node.textContent === 'Accounts');
         return entries > 0 && !broken && accounts;
       } finally {
         await window.workbench.invoke('account.remove', { id: account.id });
       }
     })()`,
  );

  await check(
    "a delete control sits on the row it deletes",
    `(async () => {
       const row = [...document.querySelectorAll('.sidebar__row')]
         .find(node => node.textContent?.includes('Check workspace'));
       if (!row) return false;
       const label = row.querySelector('.row__text');
       const remove = row.querySelector('.sidebar__delete');
       if (!label || !remove) return false;

       const name = label.getBoundingClientRect();
       const button = remove.getBoundingClientRect();
       // Same line: the control's centre is inside the label's height, and it
       // sits beside the name rather than under it.
       const centre = button.top + button.height / 2;
       return centre > name.top && centre < name.bottom && button.left > name.left;
     })()`,
  );

  await check(
    "a long screen scrolls and leaves the navigation reachable",
    `(async () => {
       // Settings is the longest screen; Providers became one line per tool
       // and no longer overflows a normal window, so it proves nothing here.
       [...document.querySelectorAll('.sidebar__foot .row')]
         .find(row => row.textContent?.includes('Settings'))?.click();
       await new Promise(resolve => setTimeout(resolve, 300));

       // The window itself must never be the thing that overflows, or the
       // sidebar's own navigation is pushed out of reach.
       const app = document.querySelector('.app');
       if (!app || app.scrollHeight > window.innerHeight + 1) return false;

       const foot = document.querySelector('.sidebar__foot');
       const bounds = foot?.getBoundingClientRect();
       if (!bounds || bounds.bottom > window.innerHeight + 1) return false;

       // The screen's own content is what scrolls.
       const view = document.querySelector('.view');
       if (!view || view.scrollHeight <= view.clientHeight) return false;
       view.scrollTop = 80;
       return view.scrollTop > 0;
     })()`,
  );

  // --- workspace tooling -------------------------------------------------

  // The checks above ended on another view; the workspace tools belong to a
  // session, so the session is reopened first.
  await check(
    "returns to the session from another view",
    `(async () => {
       [...document.querySelectorAll('.sidebar__scroll .row')]
         .find(node => node.textContent?.includes('Check session'))?.click();
       await new Promise(resolve => setTimeout(resolve, 400));
       return Boolean(document.querySelector('.composer'));
     })()`,
  );

  await check(
    "terminal starts a real shell and streams its output back",
    `(async () => {
       // Ctrl+\` is the documented shortcut, so the check uses it.
       window.dispatchEvent(new KeyboardEvent('keydown', { key: '\`', ctrlKey: true, bubbles: true }));
       await new Promise(resolve => setTimeout(resolve, 800));
       if (!document.querySelector('.xterm')) return false;

       const sessionId = window.__checkSessionId;
       const terminals = await window.workbench.invoke('terminal.list', { sessionId });
       if (terminals.length !== 1) return false;
       const terminalId = terminals[0].id;

       // The output is asserted on the stream the view itself consumes, which
       // does not depend on how xterm happens to render.
       const seen = await new Promise(resolve => {
         let buffer = '';
         const off = window.workbench.onTerminalEvent(event => {
           if (event.terminalId !== terminalId || event.type !== 'data') return;
           buffer += event.chunk;
           if (buffer.includes('check-terminal-works')) { off(); resolve(true); }
         });
         window.workbench.invoke('terminal.write', {
           terminalId,
           data: 'echo check-terminal-works\\n',
         });
         setTimeout(() => { off(); resolve(false); }, 8000);
       });
       if (!seen) return false;

       // Reattaching must return the shell that is already running, with what
       // it printed, rather than starting a second one.
       const attached = await window.workbench.invoke('terminal.attach', { sessionId });
       return attached.info.id === terminalId
         && attached.scrollback.includes('check-terminal-works');
     })()`,
  );

  await check(
    "tool calls are collapsed and can be opened",
    `(async () => {
       const sessionId = window.__checkSessionId;
       const done = new Promise(resolve => {
         const off = window.workbench.onEvent(event => {
           if (event.type === 'message.updated' && event.message.sessionId === sessionId) {
             off();
             resolve(event.message);
           }
         });
       });
       await window.workbench.invoke('session.sendMessage', {
         sessionId,
         text: 'please /tool',
       });
       await done;
       await new Promise(resolve => setTimeout(resolve, 300));

       const summary = document.querySelector('.tool-call__summary');
       if (!summary) return false;
       // Collapsed by default (spec §79).
       if (document.querySelector('.tool-call__body')) return false;

       summary.click();
       await new Promise(resolve => setTimeout(resolve, 200));
       return Boolean(document.querySelector('.tool-call__body'));
     })()`,
  );

  await check(
    "files view lists the workspace",
    `(async () => {
       [...document.querySelectorAll('.panel__tab')]
         .find(node => node.textContent === 'Files')?.click();
       await new Promise(resolve => setTimeout(resolve, 400));
       const entries = [...document.querySelectorAll('.files__entry')];
       if (entries.length === 0) return false;

       // Opening a file must show its contents.
       entries.find(node => node.textContent?.includes('notes.md'))?.click();
       await new Promise(resolve => setTimeout(resolve, 400));
       return (document.querySelector('.files__code')?.textContent ?? '')
         .includes('workspace file');
     })()`,
  );

  await check(
    repository
      ? "changes view shows the branch and a change"
      : "changes view reports a directory without git",
    repository
      ? `(async () => {
           // The tab carries its count ("Changes · 2"), so it is found by name.
           [...document.querySelectorAll('.panel__tab')]
             .find(node => node.textContent?.startsWith('Changes'))?.click();
           await new Promise(resolve => setTimeout(resolve, 600));
           const branch = document.querySelector('.changes__branch')?.textContent ?? '';
           const items = [...document.querySelectorAll('.changes__item')]
             .map(node => node.textContent ?? '');
           return branch.includes('main') && items.some(text => text.includes('untracked.txt'));
         })()`
      : `(async () => {
           [...document.querySelectorAll('.panel__tab')]
             .find(node => node.textContent?.startsWith('Changes'))?.click();
           await new Promise(resolve => setTimeout(resolve, 600));
           return (document.querySelector('.changes')?.textContent ?? '')
             .includes('not a git repository');
         })()`,
  );

  // --- skills, plugins and MCP -------------------------------------------

  await check(
    "a skill switched on for a session reaches the provider",
    `(async () => {
       const sessionId = window.__checkSessionId;
       await window.workbench.invoke('skill.save', {
         schemaVersion: 1,
         id: 'check-skill',
         name: 'Check skill',
         description: 'Used by the startup check',
         version: '1.0.0',
         instructions: 'Always mention check-skill-instruction.',
         requiredCapabilities: [],
         tools: [],
         mcpDependencies: [],
         metadata: {},
         source: { kind: 'import' },
       });

       // Switched on through the Skills screen, the way a user does it.
       [...document.querySelectorAll('.sidebar__foot .row')]
         .find(row => row.textContent?.includes('Skills'))?.click();
       await new Promise(resolve => setTimeout(resolve, 400));
       const entry = [...document.querySelectorAll('.provider-entry')]
         .find(node => node.textContent?.includes('Check skill'));
       if (!entry) return false;
       // Entries are collapsed to one line; open this one the way a user does.
       const header = entry.querySelector('.provider-entry__toggle');
       if (header && header.getAttribute('aria-expanded') === 'false') {
         header.click();
         await new Promise(resolve => setTimeout(resolve, 200));
       }
       const toggle = [...entry.querySelectorAll('.scope-toggle')]
         .find(node => node.textContent?.includes('This session'))
         ?.querySelector('input');
       if (!toggle || toggle.disabled) return false;
       // The resume run finds it already on, and must not switch it off.
       if (!toggle.checked) {
         toggle.click();
         await new Promise(resolve => setTimeout(resolve, 400));
       }

       const effective = await window.workbench.invoke(
         'skill.effectiveForSession', { sessionId });
       if (!effective.some(item => item.skill.id === 'check-skill')) return false;

       // The provider must actually receive it as instructions, not just the
       // application believe it does. The answer is read back from the stored
       // conversation, so this does not depend on event naming.
       await window.workbench.invoke('session.sendMessage', {
         sessionId,
         text: '/context',
       });
       const deadline = Date.now() + 15000;
       while (Date.now() < deadline) {
         await new Promise(resolve => setTimeout(resolve, 200));
         const messages = await window.workbench.invoke('message.list', { sessionId });
         if (messages.some(message => (message.content ?? '')
             .includes('check-skill-instruction'))) {
           return true;
         }
       }
       return false;
     })()`,
  );

  await check(
    "an MCP server that cannot start is reported, not thrown",
    `(async () => {
       await window.workbench.invoke('mcp.save', {
         id: 'check-missing',
         name: 'Check missing server',
         transport: 'stdio',
         command: 'definitely-not-an-executable-9f3c',
         args: [],
         env: {},
         enabled: true,
       });
       const status = await window.workbench.invoke('mcp.connect', { id: 'check-missing' });
       if (!status || status.state !== 'failed' || !status.detail) return false;

       // And the screen says so rather than showing it as usable.
       [...document.querySelectorAll('.sidebar__foot .row')]
         .find(row => row.textContent?.includes('MCP servers'))?.click();
       await new Promise(resolve => setTimeout(resolve, 600));
       const entry = [...document.querySelectorAll('.provider-entry')]
         .find(node => node.textContent?.includes('Check missing server'));
       return Boolean(entry && entry.textContent?.includes('Failed'));
     })()`,
  );

  await check(
    "a session can be given access to an MCP server",
    `(async () => {
       const sessionId = window.__checkSessionId;
       await window.workbench.invoke(
         'mcp.setSessionAccess', { sessionId, serverId: 'check-missing', enabled: true });
       const access = await window.workbench.invoke('mcp.sessionAccess', { sessionId });
       return access.serverIds.includes('check-missing');
     })()`,
  );

  await check(
    "connecting an account never falls back to plaintext",
    `(async () => {
       [...document.querySelectorAll('.sidebar__foot .row')]
         .find(row => row.textContent?.includes('Plugins'))?.click();
       await new Promise(resolve => setTimeout(resolve, 300));

       // Either the operating system stores the secret, or the attempt is
       // refused with a reason. Storing it unprotected is not an outcome.
       try {
         const account = await window.workbench.invoke('plugin.connectAccount', {
           accountType: 'check-service',
           label: 'Check account',
           secret: 'check-secret-value',
         });
         const accounts = await window.workbench.invoke('plugin.accounts', undefined);
         const stored = accounts.find(entry => entry.id === account.id);
         // Only a reference is ever handed back to the renderer.
         return Boolean(stored)
           && !JSON.stringify(stored).includes('check-secret-value');
       } catch (error) {
         return String(error).includes('Secure storage is not available');
       }
     })()`,
  );

  await check(
    "a team runs a goal to completion through the interface",
    `(async () => {
       [...document.querySelectorAll('.sidebar__foot .row')]
         .find(row => row.textContent?.includes('Teams'))?.click();
       await new Promise(resolve => setTimeout(resolve, 400));
       if (![...document.querySelectorAll('.view__title')]
             .some(node => node.textContent === 'Teams')) return false;

       // A team of three, all on the same registered provider.
       const workspaceId = window.__checkWorkspaceId;
       // The resume phase finds the team the first phase created.
       const existing = (await window.workbench.invoke('team.list', { workspaceId }))
         .find(entry => entry.name === 'Check team');
       const team = existing ?? await window.workbench.invoke('team.create', {
         workspaceId,
         name: 'Check team',
         agents: [
           { displayName: 'Lead', providerId: 'mock', role: 'plans', skills: [], plugins: [], mcpServers: [], settings: {} },
           { displayName: 'Builder', providerId: 'mock', role: 'implements', skills: [], plugins: [], mcpServers: [], settings: {} },
           { displayName: 'Reviewer', providerId: 'mock', role: 'reviews', skills: [], plugins: [], mcpServers: [], settings: {} },
         ],
       });
       if (team.agents.length !== 3 || team.leadAgentId !== team.agents[0].id) return false;

       const run = await window.workbench.invoke('team.startRun', {
         teamId: team.id,
         goal: 'Check that the team really collaborates',
       });

       // Wait for the run to settle, reading the run itself rather than the UI.
       let snapshot = null;
       const deadline = Date.now() + 25000;
       while (Date.now() < deadline) {
         await new Promise(resolve => setTimeout(resolve, 200));
         snapshot = await window.workbench.invoke('team.getRun', { runId: run.id });
         if (snapshot.run.status !== 'running' && snapshot.run.status !== 'pending') break;
       }
       if (!snapshot || snapshot.run.status !== 'completed') return false;
       if (snapshot.run.stopReason !== 'goalFinished') return false;

       // The lead delegated rather than doing it all itself, and the work
       // actually came back.
       const assignees = new Set(snapshot.tasks.map(task => task.assignedTo));
       if (assignees.size < 2 || assignees.has(team.leadAgentId)) return false;
       if (!snapshot.tasks.every(task => task.status === 'completed')) return false;
       if (snapshot.artifacts.length < 2) return false;

       // And the screen shows it without being told to reload.
       [...document.querySelectorAll('.sidebar__foot .row')]
         .find(row => row.textContent?.includes('Teams'))?.click();
       await new Promise(resolve => setTimeout(resolve, 600));
       const entry = [...document.querySelectorAll('.provider-entry')]
         .find(node => node.textContent?.includes('Check team'));
       if (!entry || !entry.textContent?.includes('3 agents')) return false;

       const runRow = [...entry.querySelectorAll('.row')]
         .find(node => node.textContent?.includes('really collaborates'));
       if (!runRow) return false;
       runRow.click();
       await new Promise(resolve => setTimeout(resolve, 600));
       const detail = document.querySelector('.run-detail');
       return Boolean(detail && detail.textContent?.includes('Finished')
         && detail.querySelectorAll('.changes__item').length >= 2);
     })()`,
  );

  // --- status island: widgets, priority, deep links ---------------------------

  await check(
    "a finished run is reported as completed work",
    `(async () => {
       const state = await window.workbench.invoke('statusIsland.getState', undefined);
       const entry = state.entries.find(item => item.widget === 'completedWork');
       if (!entry) return false;
       const runs = await window.workbench.invoke('team.listRuns', {});
       const run = runs.find(item => item.status === 'completed');
       if (!run) return false;
       const snapshot = await window.workbench.invoke('team.getRun', { runId: run.id });
       const total = snapshot.tasks.length;
       const done = snapshot.tasks.filter(task => task.status === 'completed').length;
       return entry.key === 'run:' + run.id + ':done'
         && entry.detail.includes(done + ' of ' + total + ' tasks finished');
     })()`,
  );

  // The failing team runs before the asking one: on a fresh start no
  // question is waiting yet, so the failure's own card is what shows.
  // A third team whose worker cannot do the work: the failure must surface as
  // an error entry with the reason, and take the island while it is news.
  // The entry persists after the run (a failed task stays failed), but the
  // expansion only holds for a moment, so the loop latches both.
  await check(
    "a failed task surfaces its error on the island",
    `(async () => {
       const api = window.workbench;
       const workspaceId = window.__checkWorkspaceId;
       const existing = (await api.invoke('team.list', { workspaceId }))
         .find(entry => entry.name === 'Check failing team');
       const team = existing ?? await api.invoke('team.create', {
         workspaceId,
         name: 'Check failing team',
         agents: [
           { displayName: 'Lead', providerId: 'mock', role: 'plans', skills: [], plugins: [], mcpServers: [], settings: {} },
           { displayName: 'Worker', providerId: 'mock', role: 'works', skills: [], plugins: [], mcpServers: [], settings: {} },
         ],
       });
       await api.invoke('statusIsland.setPreferences', { autoExpand: true });
       // A failure takes the island while it is news and then settles (spec
       // §97), so an old run that was already announced proves nothing. The
       // team is reused; the failure is always a fresh one.
       const run = await api.invoke('team.startRun', {
         teamId: team.id,
         goal: 'Check failure surfacing [fail: the test API is down]',
       });

       const deadline = Date.now() + 25000;
       let snapshot = null;
       let expandedForError = false;
       while (Date.now() < deadline) {
         await new Promise(resolve => setTimeout(resolve, 200));
         snapshot = await api.invoke('team.getRun', { runId: run.id });
         const state = await api.invoke('statusIsland.getState', undefined);
         if (state.expanded && state.current.widget === 'errors') {
           expandedForError = true;
         }
         if (snapshot.run.status !== 'running' && snapshot.run.status !== 'pending') break;
       }
       if (!snapshot || snapshot.run.status !== 'completed') return false;
       // The entry is still there after the run: the failure was not consumed.
       const state = await api.invoke('statusIsland.getState', undefined);
       const entry = state.entries.find(item => item.widget === 'errors');
       const surfaced = Boolean(entry) && entry.priority === 80
         && (entry.detail ?? '').includes('the test API is down');
       return surfaced && expandedForError;
     })()`,
    60_000,
  );

  // Whether a question is already waiting decides what the island may show
  // for the failure; see the second branch.
  if (mode === "create") {
    await checkMain("the expanded island offers to open the run", async () => {
      const target = islandWindow();
      if (!target) {
        return false;
      }
      // The page measures its card and reports back, so the window settles a
      // few hops after the service: poll for the card, not a single read.
      const deadline = Date.now() + 8_000;
      while (Date.now() < deadline) {
        const bounds = target.getBounds();
        const actions = await islandJs(
          "[...document.querySelectorAll('.isl__actions button')].map(node => node.textContent)",
        );
        if (
          // The card opens beside the circle, so the window holds both.
          bounds.width >= 340 &&
          bounds.height > 90 &&
          Array.isArray(actions) &&
          actions.some((label) => typeof label === "string" && label.includes("Open"))
        ) {
          return true;
        }
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
      return false;
    });

    // The deep link the island offers, clicked where a user clicks it: the main
    // window lands on the run the entry is about, and the island settles back.
    await checkMain("the island opens the run it is about", async () => {
      try {
        const clicked = await islandJs(
          `(() => {
             const button = [...document.querySelectorAll('.isl__actions button')]
               .find(node => node.textContent === 'Open');
             if (!button) return false;
             button.click();
             return true;
           })()`,
        );
        return clicked === true;
      } catch {
        return false;
      }
    });

    await check(
      "opening from the island shows the run it is about",
      `(async () => {
         return ${waitFor("document.querySelector('.run-detail')?.textContent?.includes('failure surfacing') ?? false", 8000)};
       })()`,
    );

    await checkMain("handling the entry returns the island to compact", async () => {
      const target = islandWindow();
      if (!target) {
        return false;
      }
      // Same async settle in reverse: the circle (42px plus the room for its
      // ring and badge) measures back.
      const deadline = Date.now() + 8_000;
      while (Date.now() < deadline) {
        const bounds = target.getBounds();
        const actions = await islandJs(
          "document.querySelectorAll('.isl__actions').length",
        );
        const state = await island.refresh();
        if (
          bounds.width <= 72 &&
          bounds.height <= 72 &&
          actions === 0 &&
          state.expanded === false
        ) {
          return true;
        }
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
      return false;
    });

  } else {
    // A question an agent asked outranks news on the island: while one is
    // waiting on a person, the island stays on the question and does not open
    // the failure's card on its own. Nobody can answer a question inside the
    // application yet, so the one asked in the first phase is still waiting in
    // the second — which is exactly where this rule shows.
    await checkMain("a waiting question keeps the island on the question", async () => {
      const target = islandWindow();
      if (!target) {
        return false;
      }
      const label = await islandJs(
        "document.querySelector('.isl')?.getAttribute('aria-label') ?? ''",
      );
      const cards = await islandJs("document.querySelectorAll('.isl__actions').length");
      return (
        typeof label === "string" &&
        label.includes("needs your attention") &&
        // Named by the agent, not by its id.
        !/agent_[0-9a-f-]{8,}/.test(label) &&
        cards === 0
      );
    });

    // An agent's question is shown as a waiting entry with Dismiss and
    // Approve; until answering lands in the application, Approve takes the
    // person to the run that asked.
    await checkMain("the island opens the waiting entry it is about", async () => {
      try {
        const answered = await islandJs(
          `(async () => {
             document.querySelector('.isl__circle')?.click();
             await new Promise(resolve => setTimeout(resolve, 600));
             const button = [...document.querySelectorAll('.isl__actions button')]
               .find(node => node.textContent?.trim() === 'Approve');
             if (!button) return false;
             button.click();
             return true;
           })()`,
        );
        return answered === true;
      } catch {
        return false;
      }
    });

    await check(
      "opening the waiting entry shows the run that asked",
      `(async () => {
         return ${waitFor("document.querySelector('.run-detail')?.textContent?.includes('attention flow') ?? false", 8000)};
       })()`,
    );

  }

  // A second team whose workers ask a mate: the run stays green while the
  // questions stay unread, because nobody they were sent to ever reads them.
  await check(
    "agents stay visible while they work, with counted progress",
    `(async () => {
       const api = window.workbench;
       const workspaceId = window.__checkWorkspaceId;
       const existing = (await api.invoke('team.list', { workspaceId }))
         .find(entry => entry.name === 'Check attention team');
       const team = existing ?? await api.invoke('team.create', {
         workspaceId,
         name: 'Check attention team',
         agents: [
           { displayName: 'Lead', providerId: 'mock', role: 'plans', skills: [], plugins: [], mcpServers: [], settings: {} },
           { displayName: 'Asker', providerId: 'mock', role: 'works', skills: [], plugins: [], mcpServers: [], settings: {} },
           { displayName: 'Helper', providerId: 'mock', role: 'helps', skills: [], plugins: [], mcpServers: [], settings: {} },
         ],
       });
       // An ineffective auto-expand would hide the override below, so it is
       // switched off first and proven against the fresh question.
       await api.invoke('statusIsland.setPreferences', { autoExpand: false });
       const run = await api.invoke('team.startRun', {
         teamId: team.id,
         goal: 'Check attention flow [ask: is the test contract final?]',
       });

       let sawAgents = false;
       let progressMatched = false;
       let sawQuestion = false;
       let expandedWhileOff = false;
       const deadline = Date.now() + 25000;
       let snapshot = null;
       while (Date.now() < deadline) {
         await new Promise(resolve => setTimeout(resolve, 200));
         snapshot = await api.invoke('team.getRun', { runId: run.id });
         const state = await api.invoke('statusIsland.getState', undefined);
         if (state.expanded) {
           expandedWhileOff = true;
         }
         if (state.entries.some(item => item.widget === 'activeAgents')) {
           sawAgents = true;
         }
         if (state.entries.some(item => item.widget === 'needsAttention')) {
           sawQuestion = true;
         }
         const progress = state.entries.find(item => item.widget === 'teamProgress');
         if (progress && progress.progress && snapshot.tasks.length > 0) {
           const done = snapshot.tasks.filter(task => task.status === 'completed').length;
           if (progress.progress.total === snapshot.tasks.length
             && progress.progress.completed === done) {
             progressMatched = true;
           }
         }
         if (snapshot.run.status !== 'running' && snapshot.run.status !== 'pending') break;
       }
       if (!snapshot || snapshot.run.status !== 'completed') return false;
       // With auto-expand off the question is selected but never expands.
       return sawAgents && progressMatched && sawQuestion && !expandedWhileOff;
     })()`,
    60_000,
  );

  await check(
    "an unanswered question asks for attention, without expanding",
    `(async () => {
       const state = await window.workbench.invoke('statusIsland.getState', undefined);
       const entry = state.entries.find(item => item.widget === 'needsAttention');
       return Boolean(entry)
         && entry.priority === 100
         && entry.key.startsWith('msg:')
         && entry.action !== null
         && entry.action.target.view === 'teams'
         && state.expanded === false;
     })()`,
  );

  await check(
    "the palette cycles the island widget",
    `(async () => {
       // Which widget is second depends on what the application currently
       // knows, so the step is checked against the order the island reports.
       const before = await window.workbench.invoke('statusIsland.pinWidget', { widget: null });
       const expected = before.entries[1]?.widget;
       if (!expected) return false;
       window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true }));
       await new Promise(resolve => setTimeout(resolve, 120));
       // The palette lists only the first handful of commands until something
       // is typed, so the command is searched for the way a person reaches it.
       const input = document.querySelector('.palette__input');
       if (!input) return false;
       const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
       setValue.call(input, 'Cycle Status Island');
       input.dispatchEvent(new Event('input', { bubbles: true }));
       await new Promise(resolve => setTimeout(resolve, 150));
       const item = [...document.querySelectorAll('.palette__item')]
         .find(node => node.textContent?.includes('Cycle Status Island widget'));
       if (!item) return false;
       item.click();
       await new Promise(resolve => setTimeout(resolve, 400));
       if (document.querySelector('.palette') !== null) return false;
       const state = await window.workbench.invoke('statusIsland.getState', undefined);
       return state.current.widget === expected
         && state.preferences.pinnedWidget === expected;
     })()`,
  );

  await check(
    "the palette finds a tool's models by the tool's name, and says whose they are",
    `(async () => {
       window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true }));
       await new Promise(resolve => setTimeout(resolve, 120));
       const input = document.querySelector('.palette__input');
       if (!input) return 'no palette';
       const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
       setValue.call(input, 'Mock Provider');
       input.dispatchEvent(new Event('input', { bubbles: true }));
       await new Promise(resolve => setTimeout(resolve, 150));
       const item = [...document.querySelectorAll('.palette__item')]
         .find(node => node.textContent?.includes('Use model: Mock Fast'));
       const detail = item?.querySelector('.palette__group')?.textContent ?? null;
       input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
       window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
       await new Promise(resolve => setTimeout(resolve, 150));
       return detail === 'Mock Provider' || 'detail: ' + detail;
     })()`,
  );

  await check(
    "the island rests on attention in automatic mode",
    `(async () => {
       await window.workbench.invoke('statusIsland.pinWidget', { widget: null });
       const state = await window.workbench.invoke('statusIsland.getState', undefined);
       return state.preferences.pinnedWidget === null
         && state.current.widget === 'needsAttention';
     })()`,
  );

  await checkMain("the island cycles from its own keyboard", async () => {
    if (!(await pressIslandKey("ArrowRight"))) {
      return false;
    }
    return true;
  });

  await check(
    "the island keyboard step landed on the next widget",
    `(async () => {
       const state = await window.workbench.invoke('statusIsland.getState', undefined);
       await window.workbench.invoke('statusIsland.pinWidget', { widget: null });
       const expected = state.entries[1]?.widget;
       return Boolean(expected)
         && state.current.widget === expected
         && state.preferences.pinnedWidget === expected;
     })()`,
  );

  await check(
    "cycling and pinning follow the widget order",
    `(async () => {
       const api = window.workbench;
       const start = await api.invoke('statusIsland.pinWidget', { widget: null });
       const order = start.entries.map(entry => entry.widget);
       if (order.length < 2) return false;
       const first = await api.invoke('statusIsland.cycle', { direction: 1 });
       if (first.current.widget !== order[1]) return false;
       const back = await api.invoke('statusIsland.cycle', { direction: -1 });
       if (back.current.widget !== order[0]) return false;

       const pinned = await api.invoke('statusIsland.pinWidget', { widget: 'providerUsage' });
       if (pinned.current.widget !== 'providerUsage') return false;
       // Rows are named by the provider, as the island shows them.
       if (!/Mock Provider \\d+%/.test(pinned.current.title ?? '')) return false;

       // A pinned widget with nothing to say stays honest (spec §103).
       const idle = await api.invoke('statusIsland.pinWidget', { widget: 'teamProgress' });
       if (idle.current.title !== 'Team progress · nothing to report') return false;

       // Automatic mode is the priority order, highest first.
       const automatic = await api.invoke('statusIsland.pinWidget', { widget: null });
       const ordered = automatic.preferences.pinnedWidget === null
         && automatic.current.widget === order[0]
         && automatic.entries.every((entry, index, all) =>
           index === 0 || all[index - 1].priority >= entry.priority);
       // Developer mode was only for the simulated provider's usage; the rest
       // of the run looks at the application as a user would.
       await api.invoke('settings.update', { developerMode: false });
       return ordered;
     })()`,
  );

  await checkMain("the main window hides while the runtime continues", () => {
    window.hide();
    return !window.isVisible() && island.visible;
  });

  await check(
    "a message streams back with no window on screen",
    `(async () => {
       const api = window.workbench;
       const sessionId = window.__checkSessionId;
       const done = new Promise(resolve => {
         const off = api.onEvent(event => {
           if (event.type === 'message.updated' && event.message.sessionId === sessionId) {
             off();
             resolve(event.message);
           }
         });
       });
       await api.invoke('session.sendMessage', {
         sessionId,
         text: 'still working while hidden?',
       });
       const answer = await done;
       return answer.status === 'complete';
     })()`,
  );

  await checkMain("the main window comes back", () => {
    window.show();
    return window.isVisible();
  });

  // The remaining checks expect the session's chat again.
  await check(
    "returns to the session after the settings screens",
    `(async () => {
       [...document.querySelectorAll('.sidebar__scroll .row')]
         .find(node => node.textContent?.includes('Check session'))?.click();
       await new Promise(resolve => setTimeout(resolve, 400));
       return Boolean(document.querySelector('.composer'));
     })()`,
  );

  // An optional screenshot makes the rendered result reviewable by a human
  // instead of only asserted by selectors. A screenshot failure never fails
  // the check itself — it is evidence, not the subject.
  const screenshotPath = process.env["AI_WORKBENCH_CHECK_SCREENSHOT"];
  if (screenshotPath) {
    try {
      await mkdir(dirname(screenshotPath), { recursive: true });

      /** Captures one screen, with nothing left over on top of it. */
      const capture = async (name: string, navigate: string): Promise<void> => {
        await window.webContents.executeJavaScript(
          `(async () => {
             // An overlay from an earlier check would hide the screen.
             document.querySelector('.palette__input')?.dispatchEvent(
               new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
             document.activeElement?.blur?.();
             await new Promise(resolve => setTimeout(resolve, 120));
             ${navigate}
             return true;
           })()`,
        );
        await new Promise((resolve) => setTimeout(resolve, 500));
        const file =
          name === "chat" ? screenshotPath : screenshotPath.replace(/\.png$/, `-${name}.png`);
        await writeFile(file, (await window.webContents.capturePage()).toPNG());
      };

      const sidebar = (label: string): string =>
        `[...document.querySelectorAll('.sidebar__foot .row')]
           .find(node => node.textContent?.includes(${JSON.stringify(label)}))?.click();`;

      await capture(
        "chat",
        `[...document.querySelectorAll('.sidebar__scroll .row')]
           .find(node => node.textContent?.includes('Check session'))?.click();`,
      );
      // The agents grid, which only says anything with real panes in it: one
      // pane should fill the panel, a second should bring a column.
      const openShell = `[...document.querySelectorAll('button')]
           .find(node => node.textContent?.trim() === 'Shell')?.click();
         await new Promise(resolve => setTimeout(resolve, 900));`;
      await capture(
        "agents-one",
        `[...document.querySelectorAll('.sidebar__scroll .row')]
           .find(node => node.textContent?.includes('Check session'))?.click();
         await new Promise(resolve => setTimeout(resolve, 200));
         window.dispatchEvent(new KeyboardEvent('keydown',
           { key: 'A', ctrlKey: true, shiftKey: true, bubbles: true }));
         await new Promise(resolve => setTimeout(resolve, 300));
         ${openShell}`,
      );
      await capture("agents-two", openShell);
      // The third pane is where the grid stops growing and starts scrolling.
      await capture("agents-three", openShell);
      await capture("providers", sidebar("Providers"));
      await capture("teams", sidebar("Teams"));
      await capture("settings", sidebar("Settings"));
      await capture("skills", sidebar("Skills"));
      await capture("usage", sidebar("Usage"));
      await capture("mcp", sidebar("MCP servers"));
      await capture("plugins", sidebar("Plugins"));
      await capture(
        "skills-open",
        `${sidebar("Skills")}
         await new Promise(resolve => setTimeout(resolve, 200));
         document.querySelector('.view button[aria-expanded]')?.click();`,
      );
      await capture(
        "providers-open",
        `${sidebar("Providers")}
         await new Promise(resolve => setTimeout(resolve, 200));
         document.querySelector('.view button[aria-expanded]')?.click();`,
      );
      await capture(
        "settings-bottom",
        `${sidebar("Settings")}
         await new Promise(resolve => setTimeout(resolve, 200));
         [...document.querySelectorAll('.setting-disclosure')].forEach(b => b.click());
         await new Promise(resolve => setTimeout(resolve, 200));
         const v = document.querySelector('.view'); if (v) v.scrollTop = v.scrollHeight;`,
      );
      await capture(
        "settings-middle",
        `const v = document.querySelector('.view'); if (v) v.scrollTop = Math.round(v.scrollHeight / 2) - 300;`,
      );
      await capture(
        "palette",
        `window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true }));
         await new Promise(resolve => setTimeout(resolve, 300));`,
      );
      await capture(
        "chat-panel",
        `document.querySelector('.palette__input')?.dispatchEvent(
           new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
         [...document.querySelectorAll('.sidebar__scroll .row')]
           .find(node => node.textContent?.includes('Check session'))?.click();
         await new Promise(resolve => setTimeout(resolve, 300));
         [...document.querySelectorAll('.panel__tab')]
           .find(node => node.textContent?.startsWith('Terminal'))?.click();
         await new Promise(resolve => setTimeout(resolve, 900));`,
      );

      // The island is its own window, so it is captured from its own page. It
      // hides while the main window has focus, so focus goes elsewhere first;
      // a hidden window never answers capturePage, hence the time limit.
      window.blur();
      await new Promise((resolve) => setTimeout(resolve, 1500));
      const islandTarget = islandWindow();
      if (islandTarget && islandTarget.isVisible()) {
        const image = await Promise.race([
          islandTarget.webContents.capturePage(),
          new Promise<null>((resolve) => setTimeout(() => resolve(null), 5000)),
        ]);
        if (image) {
          await writeFile(screenshotPath.replace(/\.png$/, "-island.png"), image.toPNG());
        }
      }

      // Both themes are meant to be deliberate, so both are reviewable. The
      // theme is set the way the renderer itself applies it; going through
      // settings would not reach this window, which already has its own copy.
      await capture(
        "settings-light",
        `document.documentElement.dataset.theme = 'light';
         ${sidebar("Settings")}`,
      );
      await capture("providers-light", sidebar("Providers"));
      await window.webContents.executeJavaScript(
        `document.documentElement.dataset.theme = 'dark'`,
      );

      // The agents captures switched the workspace to its terminals, and that
      // choice is remembered across a restart. The window goes back to the
      // conversation, so the next start is the one a user would get.
      await window.webContents.executeJavaScript(
        `(async () => {
           [...document.querySelectorAll('.sidebar__scroll .row')]
             .find(node => node.textContent?.includes('Check session'))?.click();
           await new Promise(resolve => setTimeout(resolve, 300));
           if (!document.querySelector('.composer')) {
             window.dispatchEvent(new KeyboardEvent('keydown',
               { key: 'A', ctrlKey: true, shiftKey: true, bubbles: true }));
             await new Promise(resolve => setTimeout(resolve, 300));
           }
           return Boolean(document.querySelector('.composer'));
         })()`,
      );

      logger.info("Startup check screenshots written", { directory: dirname(screenshotPath) });
    } catch (error) {
      logger.warn("Startup check screenshots failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // --- terminal agents waiting on the person -------------------------------
  //
  // Claude Code and Codex themselves were run against this path in
  // real-claude-attention.test.ts and real-codex-attention.test.ts. Here a
  // stand-in for each executable does what the tool does with its hooks — run
  // the commands the application handed it, each event on stdin, and act on
  // the answer the way the tool does — so the whole application path runs
  // without spending quota: the provider package's hooks and the shared
  // bridge, the terminal service, the island's entry with the tool's mark,
  // and Allow clicked on the island itself. Claude Code takes the answer from
  // its waiting hook; Codex takes it as a key in its own dialog.
  const waitingAgent = async (agent: {
    readonly providerId: string;
    readonly label: string;
    readonly command: string;
    readonly script: string;
    /** The tool it asks for, as the island names it. */
    readonly tool?: string;
    readonly summary: string;
    /** What the stand-in kept of the answer, as the tool would take it. */
    readonly answered: (printed: string) => boolean;
    readonly screenshot: string;
  }): Promise<void> => {
    const fixtureDirectory = join(dirname(workspaceDirectory), `fixture-${agent.providerId}`);
    const standIn = join(fixtureDirectory, agent.command);
    const answerFile = join(fixtureDirectory, "answer.json");
    await mkdir(fixtureDirectory, { recursive: true });
    await rm(answerFile, { force: true });
    await writeFile(standIn, agent.script, { mode: 0o755 });

    await check(
      `${agent.label} reports that it waits for a permission`,
      `(async () => {
         const api = window.workbench;
         const workspaceId = window.__checkWorkspaceId;
         await api.invoke('provider.saveConfig', {
           providerId: ${JSON.stringify(agent.providerId)}, enabled: true,
           executablePath: ${JSON.stringify(standIn)},
         });
         const tile = await api.invoke('agentTerminal.launch', {
           workspaceId, providerId: ${JSON.stringify(agent.providerId)},
           label: ${JSON.stringify(agent.label)},
         });
         window.__checkWaitingTile = tile.id;
         const deadline = Date.now() + 15000;
         while (Date.now() < deadline) {
           const tiles = await api.invoke('agentTerminal.list', { workspaceId });
           const current = tiles.find(entry => entry.id === tile.id);
           const waiting = current?.attention;
           // Mid-turn: it works on the prompt and waits for the permission.
           if (waiting && current.activity) {
             return waiting.kind === 'permission' && waiting.tool === ${JSON.stringify(agent.tool ?? "Bash")}
               && waiting.summary === ${JSON.stringify(agent.summary)} && waiting.answerable
               && current.activity.state === 'working'
               || JSON.stringify({ waiting, activity: current.activity });
           }
           await new Promise(resolve => setTimeout(resolve, 200));
         }
         return 'the tile never reported that it waits';
       })()`,
      30_000,
    );

    await checkMain(`the island shows ${agent.label} waiting with its mark, Allow and Deny`, async () => {
      // The island hides while the main window has focus.
      window.blur();
      const deadline = Date.now() + 12_000;
      let seen = "nothing";
      while (Date.now() < deadline) {
        const state = await island.refresh();
        const entry = state.entries.find(
          (item) => item.widget === "needsAttention" && item.key.startsWith("tile:"),
        );
        const target = islandWindow();
        if (entry && target?.isVisible()) {
          const face = await islandJs(
            `(async () => {
               const unit = document.querySelector('.isl');
               const mark = Boolean(document.querySelector('.isl__circle .isl__mark svg'));
               if (unit?.dataset.face === 'approval' && mark
                   && document.querySelectorAll('.isl__actions button').length === 0) {
                 // Keeps the card open, as a click on the circle does.
                 document.querySelector('.isl__circle')?.click();
                 await new Promise(resolve => setTimeout(resolve, 600));
               }
               return {
                 face: unit?.dataset.face ?? null,
                 mark,
                 buttons: [...document.querySelectorAll('.isl__actions button')]
                   .map(node => node.textContent?.trim()),
                 title: document.querySelector('.isl__attitle')?.textContent ?? '',
               };
             })()`,
          );
          seen = JSON.stringify({ icon: entry.icon, options: entry.options, face });
          const shown = face as { face: string; mark: boolean; buttons: string[]; title: string };
          if (
            entry.icon === agent.providerId &&
            shown.face === "approval" &&
            shown.mark &&
            shown.buttons.includes("Allow") &&
            shown.buttons.includes("Deny") &&
            shown.title.includes(`wants to use ${agent.tool ?? "Bash"}`)
          ) {
            return true;
          }
        }
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      throw new Error(`the island showed ${seen}`);
    });

    // Evidence for a person to look at, like the screenshots above.
    const screenshotPath = process.env["AI_WORKBENCH_CHECK_SCREENSHOT"];
    const target = islandWindow();
    if (screenshotPath && target?.isVisible()) {
      const image = await Promise.race([
        target.webContents.capturePage(),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 5000)),
      ]);
      if (image) {
        await writeFile(screenshotPath.replace(/\.png$/, `-${agent.screenshot}.png`), image.toPNG());
      }
    }

    await checkMain(`Allow on the island reaches ${agent.label}`, async () => {
      const clicked = await islandJs(
        `(() => {
           const button = [...document.querySelectorAll('.isl__actions button')]
             .find(node => node.textContent?.trim() === 'Allow');
           if (!button) return false;
           button.click();
           return true;
         })()`,
      );
      if (clicked !== true) {
        throw new Error("no Allow button on the island");
      }
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        const printed = await readFile(answerFile, "utf8").catch(() => null);
        if (printed !== null) {
          if (agent.answered(printed)) {
            return true;
          }
          throw new Error(`the tool was answered with ${printed}`);
        }
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
      throw new Error("the answer never arrived");
    });

    // The turn ended: the agent is idle at its prompt, which is rest, not work.
    await checkMain(`the island lets go once ${agent.label} no longer waits, and it rests`, async () => {
      const deadline = Date.now() + 8_000;
      let seen = "nothing";
      while (Date.now() < deadline) {
        const state = await island.refresh();
        const waiting = state.entries.some((item) => item.key.startsWith("tile:"));
        const working = state.entries
          .flatMap((item) => item.agents)
          .some((row) => row.title === agent.label);
        seen = JSON.stringify({ waiting, working, sessions: state.sessions });
        if (!waiting && !working && state.sessions.last?.name === agent.label) {
          return true;
        }
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
      throw new Error(`the island still had ${seen}`);
    });

    // The stand-in goes, and the tool is found on the PATH again.
    await check(
      `the stand-in for ${agent.label} is removed again`,
      `(async () => {
         const api = window.workbench;
         const removed = await api.invoke('agentTerminal.remove', { id: window.__checkWaitingTile });
         await api.invoke('provider.saveConfig', {
           providerId: ${JSON.stringify(agent.providerId)}, executablePath: null,
         });
         return removed.removed;
       })()`,
    );
  };

  if (process.platform !== "win32") {
    await waitingAgent({
      providerId: "claude-code",
      label: "Claude Code",
      command: "claude",
      script: STAND_IN_CLAUDE,
      summary: "touch island-allowed.txt",
      // Exactly what Claude Code reads from a permission hook.
      answered: (printed) => {
        const answer = JSON.parse(printed) as {
          hookSpecificOutput?: { hookEventName?: string; decision?: { behavior?: string } };
        };
        return (
          answer.hookSpecificOutput?.hookEventName === "PermissionRequest" &&
          answer.hookSpecificOutput.decision?.behavior === "allow"
        );
      },
      screenshot: "island-approval",
    });
    await waitingAgent({
      providerId: "codex",
      label: "Codex",
      command: "codex",
      script: STAND_IN_CODEX,
      summary: "touch island-codex.txt",
      // "y" is what Codex's own approval dialog takes for "yes, proceed".
      answered: (printed) => (JSON.parse(printed) as { key?: string }).key === "y",
      screenshot: "island-approval-codex",
    });
    await waitingAgent({
      providerId: "opencode",
      label: "OpenCode",
      command: "opencode",
      script: STAND_IN_OPENCODE,
      summary: "touch island-opencode.txt",
      // "once" is what OpenCode's own server takes for "allow this time".
      answered: (printed) => (JSON.parse(printed) as { reply?: string }).reply === "once",
      screenshot: "island-approval-opencode",
    });

    // Gemini CLI takes the island's hooks only from an extension the person
    // installs once with its own installer; the setup runs in a tile where
    // its question is answered, as a person would.
    const geminiFixture = join(dirname(workspaceDirectory), "fixture-gemini");
    const geminiHome = join(geminiFixture, "home");
    const geminiStandIn = join(geminiFixture, "gemini");
    const previousGeminiHome = process.env["GEMINI_CLI_HOME"];
    await rm(geminiHome, { recursive: true, force: true });
    await mkdir(geminiHome, { recursive: true });
    await writeFile(geminiStandIn, STAND_IN_GEMINI, { mode: 0o755 });
    process.env["GEMINI_CLI_HOME"] = geminiHome;
    await check(
      "Gemini CLI offers the island's setup, which runs with its own installer in a tile",
      `(async () => {
         const api = window.workbench;
         const workspaceId = window.__checkWorkspaceId;
         await api.invoke('provider.saveConfig', {
           providerId: 'gemini', enabled: true, executablePath: ${JSON.stringify(geminiStandIn)},
         });
         const integration = async () =>
           (await api.invoke('provider.list')).find(entry => entry.metadata.id === 'gemini')?.integration;
         const before = await integration();
         if (before?.state !== 'setupNeeded') return 'before: ' + JSON.stringify(before ?? null);
         const tile = await api.invoke('agentTerminal.setup', { workspaceId, providerId: 'gemini' });
         if (tile.purpose !== 'setup' || !tile.terminalId) return 'tile: ' + JSON.stringify(tile);
         // Gemini CLI asks before it installs; the person says yes.
         await new Promise(resolve => setTimeout(resolve, 1500));
         await api.invoke('terminal.write', { terminalId: tile.terminalId, data: 'y\\r' });
         const deadline = Date.now() + 15000;
         while (Date.now() < deadline) {
           const after = await integration();
           if (after?.state === 'ready') return true;
           await new Promise(resolve => setTimeout(resolve, 300));
         }
         return 'after: ' + JSON.stringify(await integration());
       })()`,
      30_000,
    );
    await waitingAgent({
      providerId: "gemini",
      label: "Gemini CLI",
      command: "gemini",
      script: STAND_IN_GEMINI,
      tool: "Shell",
      summary: "touch island-gemini.txt",
      // "1" is what Gemini CLI's own dialog takes for "allow once".
      answered: (printed) => (JSON.parse(printed) as { key?: string }).key === "1",
      screenshot: "island-approval-gemini",
    });
    if (previousGeminiHome === undefined) {
      delete process.env["GEMINI_CLI_HOME"];
    } else {
      process.env["GEMINI_CLI_HOME"] = previousGeminiHome;
    }
  }

  // The remote workspace is checked after the screenshots, so the screens
  // above show exactly the data the approved design was captured with.
  // --- a workspace on another machine -------------------------------------
  //
  // A real SSH server, started in this process, serving a real directory. The
  // point is to prove the whole path end to end: a connection is defined, its
  // host key is learned, a workspace is created on it, and its files are
  // browsed, opened and saved through exactly the same screens a local
  // workspace uses. Nothing here is mocked; only the machine is nearby.
  const remoteDirectory = join(dirname(workspaceDirectory), "remote");
  const hostKeyFile = join(dirname(workspaceDirectory), "remote-host-key");
  let sshServer: Awaited<ReturnType<typeof StartSshTestServer>> | null = null;

  await checkMain("a machine is reachable over SSH", async () => {
    await mkdir(join(remoteDirectory, "service"), { recursive: true });
    await writeFile(join(remoteDirectory, "README.md"), "# Remote project\n");
    await writeFile(
      join(remoteDirectory, "service", "main.ts"),
      "export const port = 8080;\n",
    );

    // The second phase has to look like the same machine, or a client that
    // remembered the host key would rightly refuse to connect.
    const stored = await readFile(hostKeyFile, "utf8").catch(() => null);
    // Loaded only here, so the shipped application does not carry a server
    // it never runs.
    const { startSshTestServer } = await import("@ai-workbench/test-support");
    sshServer = await startSshTestServer({
      directory: remoteDirectory,
      ...(stored === null ? {} : { hostKey: stored }),
    });
    if (stored === null) {
      await writeFile(hostKeyFile, sshServer.hostKey);
    }
    return sshServer.port > 0;
  });

  if (sshServer) {
    const server = sshServer as Awaited<ReturnType<typeof StartSshTestServer>>;
    const connectionScript = `{
      name: 'Check machine',
      host: ${JSON.stringify(server.host)},
      port: ${server.port},
      username: ${JSON.stringify(server.username)},
      auth: 'password',
      secret: ${JSON.stringify(server.password)},
    }`;

    await check(
      "a connection is created and proves itself",
      `(async () => {
         const api = window.workbench;
         const existing = (await api.invoke('connection.list', undefined))
           .find(entry => entry.name === 'Check machine');
         // The port changes every run, so a remembered connection is pointed
         // at the server that is actually listening now.
         const connection = existing
           ? await api.invoke('connection.update', { id: existing.id, port: ${server.port} })
           : await api.invoke('connection.create', ${connectionScript});
         window.__checkConnectionId = connection.id;

         const result = await api.invoke('connection.test', { id: connection.id });
         if (!result.ok) return 'test failed: ' + result.error;
         // Trust on first use: the key is learned once and recorded.
         if (!result.fingerprint) return 'no fingerprint';
         if (result.fingerprint !== ${JSON.stringify(server.fingerprint)}) {
           return 'wrong fingerprint: ' + result.fingerprint;
         }
         return result.homeDirectory === ${JSON.stringify(remoteDirectory)};
       })()`,
      30_000,
    );

    await check(
      "a wrong password is reported as such, not as a protocol error",
      `(async () => {
         const api = window.workbench;
         const id = window.__checkConnectionId;
         await api.invoke('connection.update', { id, secret: 'definitely-wrong' });
         const failed = await api.invoke('connection.test', { id });
         await api.invoke('connection.update', { id, secret: ${JSON.stringify(server.password)} });
         const recovered = await api.invoke('connection.test', { id });
         return failed.ok === false
           && /rejected the credentials/.test(failed.error ?? '')
           && recovered.ok === true;
       })()`,
      30_000,
    );

    await check(
      "a folder on the machine can be browsed",
      `(async () => {
         const api = window.workbench;
         const id = window.__checkConnectionId;
         const home = await api.invoke('connection.browse', { id, path: '' });
         if (home.path !== ${JSON.stringify(remoteDirectory)}) return 'home is ' + home.path;
         // Directories first, then files, exactly as a local listing.
         return home.entries.map(entry => entry.kind + ':' + entry.name).join(',')
           === 'directory:service,file:README.md';
       })()`,
      30_000,
    );

    await check(
      "a workspace is created on the machine",
      `(async () => {
         const api = window.workbench;
         const id = window.__checkConnectionId;
         const existing = (await api.invoke('workspace.list', undefined))
           .find(entry => entry.connectionId === id);
         const workspace = existing ?? await api.invoke('workspace.create', {
           name: 'Remote project',
           path: ${JSON.stringify(remoteDirectory)},
           connectionId: id,
         });
         window.__checkRemoteWorkspaceId = workspace.id;
         const session = (await api.invoke('session.list', { workspaceId: workspace.id }))[0]
           ?? await api.invoke('session.create', {
             workspaceId: workspace.id,
             name: 'Remote session',
             type: 'solo',
           });
         window.__checkRemoteSessionId = session.id;
         return workspace.connectionId === id
           && workspace.path === ${JSON.stringify(remoteDirectory)};
       })()`,
      30_000,
    );

    await check(
      "the remote workspace browses, opens and saves like a local one",
      `(async () => {
         const api = window.workbench;
         const sessionId = window.__checkRemoteSessionId;

         const listing = await api.invoke('files.list', { sessionId, path: '' });
         if (listing.map(e => e.name).join(',') !== 'service,README.md') {
           return 'listing was ' + listing.map(e => e.name).join(',');
         }

         const opened = await api.invoke('files.read', {
           sessionId, path: 'service/main.ts',
         });
         if (opened.content !== 'export const port = 8080;\\n') {
           return 'read back ' + JSON.stringify(opened.content);
         }

         // Edited and saved through the same channel the editor uses.
         await api.invoke('files.write', {
           sessionId,
           path: 'service/main.ts',
           content: 'export const port = 9090;\\n',
         });
         const reread = await api.invoke('files.read', {
           sessionId, path: 'service/main.ts',
         });
         return reread.content === 'export const port = 9090;\\n';
       })()`,
      30_000,
    );

    await checkMain("the edit really reached the other machine", async () => {
      // Read from the directory the server serves, not through the client
      // that wrote it: otherwise this would only prove the code agrees with
      // itself.
      const onDisk = await readFile(join(remoteDirectory, "service", "main.ts"), "utf8");
      return onDisk === "export const port = 9090;\n";
    });

    await check(
      "a remote workspace refuses a path outside its root",
      `(async () => {
         const api = window.workbench;
         const sessionId = window.__checkRemoteSessionId;
         try {
           await api.invoke('files.read', { sessionId, path: '../remote-host-key' });
           return false;
         } catch (error) {
           return /outside the permitted root|is not a file/.test(String(error.message ?? error));
         }
       })()`,
      30_000,
    );

    await check(
      "a connection still carrying a workspace is not silently removed",
      `(async () => {
         const api = window.workbench;
         try {
           await api.invoke('connection.delete', { id: window.__checkConnectionId });
           return false;
         } catch (error) {
           return /still used by/.test(String(error.message ?? error));
         }
       })()`,
    );

    if (mode === "resume") {
      await check(
        "the remote workspace and its host key survived the restart",
        `(async () => {
           const api = window.workbench;
           const connection = (await api.invoke('connection.list', undefined))
             .find(entry => entry.name === 'Check machine');
           if (!connection) return 'no connection';
           // The machine was recognised rather than trusted afresh.
           if (connection.hostKeyFingerprint !== ${JSON.stringify(server.fingerprint)}) {
             return 'fingerprint is ' + connection.hostKeyFingerprint;
           }
           const workspace = (await api.invoke('workspace.list', undefined))
             .find(entry => entry.connectionId === connection.id);
           if (!workspace) return 'no remote workspace';
           const sessionId = window.__checkRemoteSessionId;
           const file = await api.invoke('files.read', {
             sessionId, path: 'service/main.ts',
           });
           // The edit from the first phase is still there, on the machine.
           return file.content === 'export const port = 9090;\\n';
         })()`,
        30_000,
      );
    }
  }


  // The machine goes away with the check that started it.
  if (sshServer) {
    await (sshServer as Awaited<ReturnType<typeof StartSshTestServer>>).close();
  }

  const noRendererErrors = rendererErrors.length === 0;
  outcomes.push({
    name: "renderer reported no errors",
    passed: noRendererErrors,
    detail: rendererErrors.join(" | ") || "none",
  });

  const healthy = outcomes.every((outcome) => outcome.passed);
  for (const outcome of outcomes) {
    logger[outcome.passed ? "info" : "error"](
      `${outcome.passed ? "PASS" : "FAIL"} ${outcome.name}`,
      { detail: outcome.detail },
    );
  }

  return { healthy, outcomes };
}

/**
 * Stands in for Claude Code in the startup check: started the way the
 * application starts Claude Code, it runs one turn's hooks from the run's
 * settings file the way Claude Code does — each event on stdin, in Claude
 * Code's order — and keeps what the permission hook printed. Everything else
 * it is asked (a version probe) gets a short answer. It stays running, like
 * an interactive tool.
 */
const STAND_IN_CLAUDE = `#!/usr/bin/env node
const { spawn } = require("node:child_process");
const { writeFileSync } = require("node:fs");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const args = process.argv.slice(2);
if (args.includes("--version")) {
  process.stdout.write("2.1.280 (Claude Code)\\n");
  process.exit(0);
}
const at = args.indexOf("--settings");
if (at < 0) {
  process.exit(0);
}
const settings = JSON.parse(readFileSync(args[at + 1], "utf8"));
const run = (event, input) =>
  new Promise((resolve) => {
    const command = settings.hooks[event][0].hooks[0].command;
    const hook = spawn("/bin/sh", ["-c", command], { stdio: ["pipe", "pipe", "ignore"] });
    let printed = "";
    hook.stdout.on("data", (chunk) => {
      printed += chunk;
    });
    hook.on("close", () => resolve(printed));
    hook.stdin.end(JSON.stringify({ session_id: "startup-check", hook_event_name: event, ...input }));
  });
const toolInput = { command: "touch island-allowed.txt", description: "Create a file" };
(async () => {
  await run("SessionStart", { source: "startup" });
  await run("UserPromptSubmit", { prompt: "Create island-allowed.txt" });
  process.stdout.write("Stand-in for Claude Code: asks to run touch island-allowed.txt\\r\\n");
  const printed = await run("PermissionRequest", { tool_name: "Bash", tool_input: toolInput });
  writeFileSync(join(__dirname, "answer.json"), printed);
  await run("PostToolUse", { tool_name: "Bash", tool_input: toolInput, tool_response: {} });
  await run("Stop", { stop_hook_active: false, last_assistant_message: "Done." });
  process.stdout.write("The hook answered.\\r\\n");
})();
setInterval(() => undefined, 60000);
`;

/**
 * Stands in for Codex in the startup check: started the way the application
 * starts Codex, it reads the hooks from the run's `-c hooks.<Event>=[...]`
 * overrides and runs one turn's worth in Codex's order, each event on stdin.
 * Like Codex, it does not wait on the permission hook; it then shows its own
 * approval prompt and takes a key from the terminal — "y" runs the command,
 * Esc ends the turn with the `Interrupt` hook — and keeps which key it got.
 * Everything else it is asked (a version probe, the app server) gets a short
 * answer. It stays running, like an interactive tool.
 */
const STAND_IN_CODEX = `#!/usr/bin/env node
const { spawn } = require("node:child_process");
const { writeFileSync } = require("node:fs");
const { join } = require("node:path");
const args = process.argv.slice(2);
if (args.includes("--version")) {
  process.stdout.write("codex-cli 0.156.1\\n");
  process.exit(0);
}
const hooks = {};
for (let index = 0; index < args.length - 1; index += 1) {
  const match = args[index] === "-c"
    && /^hooks\\.(\\w+)=.*?command="((?:[^"\\\\]|\\\\.)*)"/.exec(args[index + 1]);
  if (match) {
    hooks[match[1]] = match[2].replace(/\\\\(.)/g, "$1");
  }
}
if (!hooks.PermissionRequest) {
  process.exit(0);
}
const run = (event, input) =>
  new Promise((resolve) => {
    const hook = spawn("/bin/sh", ["-c", hooks[event]], { stdio: ["pipe", "ignore", "ignore"] });
    hook.on("close", resolve);
    hook.stdin.end(JSON.stringify({ session_id: "startup-check", hook_event_name: event, ...input }));
  });
const toolInput = { command: "touch island-codex.txt" };
(async () => {
  await run("SessionStart", { source: "startup" });
  await run("UserPromptSubmit", { prompt: "Create island-codex.txt" });
  await run("PermissionRequest", { tool_name: "Bash", tool_input: toolInput });
  process.stdout.write("Would you like to run the following command? touch island-codex.txt\\r\\n");
  process.stdin.setRawMode?.(true);
  process.stdin.on("data", async (chunk) => {
    const key = String(chunk);
    if (key === "y") {
      writeFileSync(join(__dirname, "answer.json"), JSON.stringify({ key }));
      await run("PostToolUse", { tool_name: "Bash", tool_input: toolInput, tool_response: "" });
      await run("Stop", { stop_hook_active: false, last_assistant_message: "Done." });
    } else if (key === "\\u001b") {
      writeFileSync(join(__dirname, "answer.json"), JSON.stringify({ key: "escape" }));
      await run("Interrupt", {});
    }
  });
})();
setInterval(() => undefined, 60000);
`;

/**
 * Stands in for OpenCode in the startup check: started the way the
 * application starts OpenCode's terminal interface — `--port` and
 * `--hostname`, the password in `OPENCODE_SERVER_PASSWORD` — it serves the
 * part of OpenCode's server the application reads: basic auth, the event
 * stream with one turn asking to run a command, the list of waiting
 * requests, and the reply route, whose answer it keeps. Everything else it
 * is asked (a version probe, models, stats) gets a short answer. It stays
 * running, like an interactive tool.
 */
const STAND_IN_OPENCODE = `#!/usr/bin/env node
const http = require("node:http");
const { writeFileSync } = require("node:fs");
const { join } = require("node:path");
const args = process.argv.slice(2);
if (args.includes("--version")) {
  process.stdout.write("1.18.32\\n");
  process.exit(0);
}
const at = args.indexOf("--port");
if (at < 0) {
  process.exit(0);
}
const port = Number(args[at + 1]);
const auth = "Basic " + Buffer.from("opencode:" + (process.env.OPENCODE_SERVER_PASSWORD || "")).toString("base64");
const request = {
  id: "per_startupcheck",
  sessionID: "ses_startupcheck",
  permission: "bash",
  patterns: ["touch island-opencode.txt"],
  metadata: { command: "touch island-opencode.txt" },
  always: ["touch *"],
};
let waiting = true;
const streams = [];
const send = (type, properties) => {
  for (const stream of streams) {
    stream.write("data: " + JSON.stringify({ id: "evt_" + Date.now(), type, properties }) + "\\n\\n");
  }
};
const json = (response, value) => {
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
};
http
  .createServer((req, response) => {
    if (req.headers.authorization !== auth) {
      response.writeHead(401).end();
      return;
    }
    if (req.url === "/event") {
      response.writeHead(200, { "content-type": "text/event-stream" });
      streams.push(response);
      send("server.connected", {});
      if (waiting) {
        send("session.status", { sessionID: request.sessionID, status: { type: "busy" } });
        send("permission.asked", request);
      }
      return;
    }
    if (req.url === "/permission") return json(response, waiting ? [request] : []);
    if (req.url === "/question") return json(response, []);
    if (req.url === "/session/status") {
      return json(response, waiting ? { [request.sessionID]: { type: "busy" } } : {});
    }
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      if (req.url !== "/permission/" + request.id + "/reply" || !waiting) {
        return json(response, false);
      }
      waiting = false;
      writeFileSync(join(__dirname, "answer.json"), body);
      json(response, true);
      send("permission.replied", { sessionID: request.sessionID, requestID: request.id, reply: JSON.parse(body).reply });
      send("session.status", { sessionID: request.sessionID, status: { type: "idle" } });
      send("session.idle", { sessionID: request.sessionID });
    });
  })
  .listen(port, "127.0.0.1", () => {
    process.stdout.write("Stand-in for OpenCode: asks to run touch island-opencode.txt\\r\\n");
  });
`;

/**
 * Stands in for Gemini CLI in the startup check. `extensions install <dir>`
 * asks the way Gemini CLI does and, on "y", copies the extension under
 * `$GEMINI_CLI_HOME/.gemini/extensions`. Started as the interactive
 * interface, it runs one turn's hooks from that installed extension in
 * Gemini CLI's order — after replacing `${extensionPath}` and `${/}` as
 * Gemini CLI does — shows its approval dialog, and takes "1" (allow once)
 * from the terminal. Everything else it is asked gets a short answer.
 */
const STAND_IN_GEMINI = `#!/usr/bin/env node
const { spawn } = require("node:child_process");
const { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");
const args = process.argv.slice(2);
const home = join(process.env.GEMINI_CLI_HOME || require("node:os").homedir(), ".gemini", "extensions");
const installed = join(home, "ai-workbench-island");
if (args.includes("--version")) {
  process.stdout.write("0.60.0\\n");
  process.exit(0);
}
if (args[0] === "extensions" && args[1] === "install") {
  process.stdout.write("Do you want to trust this folder and continue with the installation? [y/N]: ");
  process.stdin.once("data", (chunk) => {
    if (!String(chunk).trim().toLowerCase().startsWith("y")) process.exit(1);
    mkdirSync(home, { recursive: true });
    cpSync(args[2], installed, { recursive: true });
    process.stdout.write("Extension installed successfully and enabled.\\r\\n");
    process.exit(0);
  });
  return;
}
if (args.length > 0 || !existsSync(join(installed, "hooks", "hooks.json"))) {
  process.exit(0);
}
const hooks = JSON.parse(readFileSync(join(installed, "hooks", "hooks.json"), "utf8")).hooks;
const run = (event, input) =>
  new Promise((resolve) => {
    const command = hooks[event][0].hooks[0].command
      .split("\${extensionPath}").join(installed)
      .split("\${/}").join("/");
    const hook = spawn("/bin/sh", ["-c", command], { stdio: ["pipe", "ignore", "ignore"] });
    hook.on("close", resolve);
    hook.stdin.end(JSON.stringify({
      session_id: "startup-check", hook_event_name: event, timestamp: new Date().toISOString(), ...input,
    }));
  });
const toolInput = { command: "touch island-gemini.txt", description: "Create a file" };
(async () => {
  await run("SessionStart", { source: "startup" });
  await run("BeforeAgent", { prompt: "Create island-gemini.txt" });
  await run("BeforeTool", { tool_name: "run_shell_command", tool_input: toolInput });
  await run("Notification", {
    notification_type: "ToolPermission",
    message: "Tool Confirm Shell Command requires execution",
    details: { type: "exec", title: "Confirm Shell Command", command: toolInput.command },
  });
  process.stdout.write("Allow execution of [Shell]?  1. Allow once  2. Allow for this session  3. No (esc)\\r\\n");
  process.stdin.setRawMode?.(true);
  process.stdin.on("data", async (chunk) => {
    if (String(chunk) === "1") {
      writeFileSync(join(__dirname, "answer.json"), JSON.stringify({ key: "1" }));
      await run("AfterTool", { tool_name: "run_shell_command", tool_input: toolInput, tool_response: {} });
      await run("AfterAgent", { prompt: "Create island-gemini.txt", prompt_response: "Done." });
    }
  });
})();
setInterval(() => undefined, 60000);
`;

/**
 * Gives the check workspace something to show: files to browse and, when git is
 * available, a repository with a branch and a change.
 */
async function seedWorkspace(directory: string): Promise<boolean> {
  await mkdir(join(directory, "src"), { recursive: true });
  await writeFile(join(directory, "notes.md"), "# Notes\n\nA workspace file.\n");
  await writeFile(join(directory, "src/app.ts"), "export const answer = 42;\n");

  try {
    const run = async (...args: string[]): Promise<number | null> => {
      const { exit } = await execCli({
        executablePath: "git",
        args,
        cwd: directory,
        timeoutMs: 15_000,
      });
      return exit.code;
    };

    if ((await run("init", "--initial-branch", "main")) !== 0) {
      return false;
    }
    // Every step below must succeed: a half-initialized repository (no user,
    // nothing committed) would make the changes-view checks lie, so any
    // non-zero exit falls back to the no-git path instead.
    if ((await run("config", "user.email", "check@example.com")) !== 0) {
      return false;
    }
    if ((await run("config", "user.name", "Startup check")) !== 0) {
      return false;
    }
    if ((await run("add", "notes.md")) !== 0) {
      return false;
    }
    if ((await run("commit", "-m", "initial")) !== 0) {
      // The second phase seeds the same directory again, where the tree is
      // already committed and there is nothing to commit. That is fine as long
      // as the repository really does have a commit; anything else still falls
      // back to the no-git path.
      if ((await run("rev-parse", "--verify", "HEAD")) !== 0) {
        return false;
      }
    }
    await writeFile(join(directory, "untracked.txt"), "new file\n");
    return true;
  } catch {
    // git is optional; the check adapts to its absence.
    return false;
  }
}

/**
 * Creates a workspace and a session, sends a message and waits for the answer
 * to be persisted — the G1 path, executed inside the renderer.
 */
function createScenario(workspaceDirectory: string): string {
  return `(async () => {
    const api = window.workbench;
    const workspace = await api.invoke('workspace.create', {
      name: 'Check workspace',
      path: ${JSON.stringify(workspaceDirectory)},
    });

    const session = await api.invoke('session.create', {
      workspaceId: workspace.id,
      name: 'Check session',
      type: 'solo',
    });

    const providers = await api.invoke('provider.list', undefined);
    const provider = providers[0];
    const model = provider.models[0];
    await api.invoke('session.update', {
      id: session.id,
      providerId: provider.metadata.id,
      modelId: model.id,
    });

    const done = new Promise(resolve => {
      const off = api.onEvent(event => {
        if (event.type === 'message.updated' && event.message.sessionId === session.id) {
          off();
          resolve(event.message);
        }
      });
    });

    await api.invoke('session.sendMessage', { sessionId: session.id, text: 'hello' });
    const answer = await done;

    // Later checks address this session and workspace directly.
    window.__checkSessionId = session.id;
    window.__checkWorkspaceId = workspace.id;

    const stored = await api.invoke('message.list', { sessionId: session.id });
    const usage = await api.invoke('provider.getUsage', undefined);
    const reported = usage.snapshots.find(entry => entry.providerId === provider.metadata.id);

    return (
      answer.status === 'complete' &&
      answer.content.includes(model.id) &&
      stored.length === 2 &&
      reported?.state === 'available' &&
      reported.limits.length > 0
    );
  })()`;
}

/**
 * Second phase, run against the same user-data directory after a real restart:
 * the conversation must still be there and the provider session must be reused
 * rather than recreated.
 */
function resumeScenario(): string {
  return `(async () => {
    const api = window.workbench;
    const workspaces = await api.invoke('workspace.list', undefined);
    const workspace = workspaces.find(entry => entry.name === 'Check workspace');
    if (!workspace) return false;

    const sessions = await api.invoke('session.list', { workspaceId: workspace.id });
    const session = sessions.find(entry => entry.name === 'Check session');
    if (!session || !session.providerSessionId) return false;
    window.__checkSessionId = session.id;
    window.__checkWorkspaceId = workspace.id;

    // The first phase may have exchanged several turns; what matters is that
    // the conversation is still there and grows from where it left off.
    const before = await api.invoke('message.list', { sessionId: session.id });
    if (before.length < 2) return false;

    const done = new Promise(resolve => {
      const off = api.onEvent(event => {
        if (event.type === 'message.updated' && event.message.sessionId === session.id) {
          off();
          resolve(event.message);
        }
      });
    });

    await api.invoke('session.sendMessage', {
      sessionId: session.id,
      text: 'still here after restart?',
    });
    const answer = await done;

    const after = await api.invoke('message.list', { sessionId: session.id });
    const reloaded = (await api.invoke('session.list', { workspaceId: workspace.id }))
      .find(entry => entry.id === session.id);

    return (
      answer.status === 'complete' &&
      after.length === before.length + 2 &&
      reloaded.providerSessionId === session.providerSessionId
    );
  })()`;
}

/** Polls a renderer-side condition until it holds or the budget runs out. */
function focusWindow(window: BrowserWindow): void {
  if (!window.isVisible()) {
    window.show();
  }
  window.focus();
  window.webContents.focus();
}

function waitFor(condition: string, timeoutMs = 4000): string {
  return `(() => new Promise(resolve => {
    const deadline = Date.now() + ${timeoutMs};
    const tick = () => {
      let value = false;
      try { value = Boolean(${condition}); } catch { value = false; }
      if (value) { resolve(true); return; }
      if (Date.now() > deadline) { resolve(false); return; }
      setTimeout(tick, 50);
    };
    tick();
  }))()`;
}

function once(
  window: BrowserWindow,
  event: "did-finish-load",
  timeoutMs = 30_000,
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!window.webContents.isLoading()) {
      resolve();
      return;
    }
    // A load that never finishes must reject instead of hanging the whole
    // verification with no output; the timer is cleared on every settle path.
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`timed out waiting for ${event} after ${timeoutMs}ms`));
    }, timeoutMs);
    timer.unref?.();
    const onLoad = (): void => {
      cleanup();
      resolve();
    };
    const onFail = (
      _event: unknown,
      errorCode: number,
      errorDescription: string,
    ): void => {
      cleanup();
      reject(
        new Error(
          `renderer failed to load: ${errorDescription} (${errorCode})`,
        ),
      );
    };
    const cleanup = (): void => {
      clearTimeout(timer);
      window.webContents.removeListener(event, onLoad);
      window.webContents.removeListener("did-fail-load", onFail);
    };
    window.webContents.once(event, onLoad);
    window.webContents.on("did-fail-load", onFail);
  });
}
