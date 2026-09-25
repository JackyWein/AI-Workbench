import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { BrowserWindow, screen } from "electron";
import { execCli } from "@ai-workbench/transport-cli";
import type { Logger } from "@ai-workbench/shared";
import type { startSshTestServer as StartSshTestServer } from "@ai-workbench/test-support";
import type { IslandController } from "./island-controller.js";

/** Opens the stand-in machine's key in the SSH check; nothing real. */
const CHECK_KEY_PASSPHRASE = "check passphrase";

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
    /** Leaves the updater as a finished download would, or at rest (null). */
    simulateDownload: (build: { version: string; commit: string } | null) => void;
  },
): Promise<StartupCheckResult> {
  const { workspaceDirectory, mode, island, simulateDownload } = options;
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
    // A session that works with a team opens as that team after a restart,
    // before anything else has asked for the teams. It used to open as an
    // empty conversation until the Teams screen or the model menu was opened.
    await check(
      "a team session is still a team session after a restart",
      `(async () => {
         const row = [...document.querySelectorAll('.sidebar__scroll .row')]
           .find(node => node.textContent?.includes('Team space'));
         if (!row) return 'no sidebar row for the team workspace';
         row.click();
         const shown = await ${waitFor("document.querySelector('.team-run, .team-intro')", 4000)};
         [...document.querySelectorAll('.sidebar__scroll .row')]
           .find(node => node.textContent?.includes('Check workspace'))?.click();
         await new Promise(resolve => setTimeout(resolve, 400));
         return shown ? true : 'the session opened without its team';
       })()`,
    );

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

  // A file outside the workspace, the way a person attaches one from
  // anywhere; the session keeps its own copy and the mock names it back.
  const attached = join(dirname(workspaceDirectory), "check-attachments", "check dot.png");
  await mkdir(dirname(attached), { recursive: true });
  await writeFile(attached, "not really a picture");
  await check(
    "a file sent with a message is kept, answered and shown with it",
    `(async () => {
       const plus = document.querySelector('.composer__iconbtn[aria-label="Attach files"]');
       if (!plus || plus.disabled) return 'the attach button is ' + (plus ? 'disabled' : 'missing');
       const sessions = await window.workbench.invoke('session.list', {});
       const session = sessions.find(entry => entry.name === 'Check session') ?? sessions[0];
       if (!session) return 'no session';
       await window.workbench.invoke('session.sendMessage', {
         sessionId: session.id,
         text: 'What is in this file?',
         attachments: [{ path: ${JSON.stringify(attached)}, name: 'check dot.png', kind: 'image' }],
       });
       const shown = await ${waitFor(
         "[...document.querySelectorAll('.message__files .file-chip')].some(node => node.textContent?.includes('check dot.png'))",
         5000,
       )};
       if (!shown) return 'no file chip on the message';
       const answered = await ${waitFor(
         "[...document.querySelectorAll('.message')].some(node => node.textContent?.includes('You attached 1 file: check dot.png (image).'))",
         10000,
       )};
       if (!answered) return 'the answer does not name the file';
       const [user] = (await window.workbench.invoke('message.list', { sessionId: session.id }))
         .filter(entry => entry.attachments.length > 0);
       const kept = user?.attachments[0]?.path ?? '';
       return kept.includes(session.id) && !kept.startsWith(${JSON.stringify(dirname(attached))})
         ? true
         : 'the message points at ' + kept + ', not a copy of its own';
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

  // Gemini CLI and OpenCode keep accounts side by side too, each its own
  // entry; the model menu names each account with its tightest reported
  // window, and the Usage screen says where each number came from.
  await check(
    "Gemini CLI and OpenCode hold further accounts; the menu and Usage show each with its limits",
    `(async () => {
       const api = window.workbench;
       const added = [];
       let flipped = false;
       const open = async (name) => {
         [...document.querySelectorAll('.sidebar__foot .row')].find(row => row.textContent?.includes(name))?.click();
         await new Promise(resolve => setTimeout(resolve, 300));
       };
       try {
         for (const family of ['gemini', 'opencode']) {
           added.push(await api.invoke('account.add', { family, label: 'Check ' + family }));
         }
         const list = await api.invoke('provider.list', undefined);
         for (const account of added) {
           if (!list.some(entry => entry.metadata.account?.label === account.label)) return 'no entry for ' + account.label;
         }
         // The simulated tool's card only shows in developer mode; the window
         // loaded its settings at start, so the switch is flipped where a
         // person would flip it.
         await open('Settings');
         [...document.querySelectorAll('.setting-disclosure')].find(node => node.textContent?.includes('Advanced'))?.click();
         await new Promise(resolve => setTimeout(resolve, 200));
         const developer = document.querySelector('input[role="switch"][aria-label="Developer mode"]');
         if (developer && !developer.checked) {
           developer.click();
           flipped = true;
         }
         await new Promise(resolve => setTimeout(resolve, 300));
         // The Usage screen: every number says where it came from and how old it is.
         await open('Usage');
         const shown = await ${waitFor("[...document.querySelectorAll('.usage-card')].some(card => card.textContent?.includes('Mock') && card.querySelector('.usage-card__source')?.textContent?.startsWith('Reported by the tool'))", 5000)};
         if (!shown) return 'the Usage screen does not say where the numbers came from';
         // The model menu: the account's tightest window next to its name.
         [...document.querySelectorAll('.sidebar__scroll .row')].find(node => node.textContent?.includes('Check session'))?.click();
         await new Promise(resolve => setTimeout(resolve, 400));
         document.querySelector('.composer .popover > .pill')?.click();
         const usage = await ${waitFor("[...document.querySelectorAll('.picker__head')].some(head => head.textContent?.includes('Mock') && /^\\d+%$/.test(head.querySelector('.picker__usage')?.textContent ?? ''))", 4000)};
         document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
         return usage || 'the menu does not show the tightest window';
       } finally {
         for (const account of added) {
           await api.invoke('account.remove', { id: account.id }).catch(() => {});
         }
         if (flipped) {
           // Back to how the window had it; the stored setting stays on for
           // the island checks that still follow.
           await open('Settings');
           [...document.querySelectorAll('.setting-disclosure')].find(node => node.textContent?.includes('Advanced'))?.click();
           await new Promise(resolve => setTimeout(resolve, 200));
           document.querySelector('input[role="switch"][aria-label="Developer mode"]')?.click();
           await new Promise(resolve => setTimeout(resolve, 200));
           await api.invoke('settings.update', { developerMode: true });
         }
       }
     })()`,
    30_000,
  );

  // --- an account at its limit (F4) ---------------------------------------
  await check(
    "a chat at its account's limit goes on on the next account, with the conversation, and says so",
    `(async () => {
       const api = window.workbench;
       const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
       const spare = await api.invoke('account.add', { family: 'mock', label: 'Check spare' });
       const spareId = 'mock@' + spare.id;
       let sessionId = null;
       // The choice is made where a person makes it: in Settings.
       const choose = async (label) => {
         [...document.querySelectorAll('.sidebar__foot .row')].find(row => row.textContent?.includes('Settings'))?.click();
         await sleep(300);
         const group = document.querySelector('[role="radiogroup"][aria-label="When an account reaches its limit"]');
         [...(group?.querySelectorAll('[role="radio"]') ?? [])].find(node => node.textContent === label)?.click();
         await sleep(300);
         return (await api.invoke('settings.get', undefined)).limitAction;
       };
       const settle = async () => {
         const deadline = Date.now() + 15000;
         while (Date.now() < deadline) {
           await sleep(200);
           const busy = (await api.invoke('session.getStatus', { sessionId })).busy;
           const messages = await api.invoke('message.list', { sessionId });
           if (!busy && messages.every(message => message.status !== 'streaming')) return messages;
         }
         return null;
       };
       const send = async (text) => {
         await api.invoke('session.sendMessage', { sessionId, text });
         return settle();
       };
       const openChat = async () => {
         const rows = () => [...document.querySelectorAll('.sidebar__scroll .row')];
         rows().find(node => node.textContent?.includes('Check workspace'))?.click();
         await sleep(500);
         rows().find(node => node.querySelector('.row__text')?.textContent === 'Limit session')?.click();
         await sleep(400);
       };
       try {
         if (await choose('Next account') !== 'switch') return 'Settings did not keep "Next account"';
         const workspace = (await api.invoke('workspace.list', undefined)).find(entry => entry.name === 'Check workspace');
         if (!workspace) return 'no workspace';
         const session = await api.invoke('session.create', {
           workspaceId: workspace.id, name: 'Limit session', type: 'solo', providerId: 'mock',
         });
         sessionId = session.id;
         await send('Remember the word heron.');
         // The default account reaches its limit; the chat goes on on the spare one.
         let messages = await send('/limit@mock /recall');
         if (!messages) return 'the chat never settled after the limit';
         const switched = messages.find(message => message.notice?.state === 'switched');
         if (!switched) return 'no switch in the chat: ' + messages.map(message => message.role + ':' + message.content.slice(0, 40)).join(' | ');
         if (switched.notice.from.providerId !== 'mock' || switched.notice.to?.providerId !== spareId) return 'the switch names the wrong accounts';
         const answer = messages.at(-1);
         if (answer.providerId !== spareId || answer.status !== 'complete') return 'the answer did not come from the spare account';
         if (!answer.content.includes('Remember the word heron.')) return 'the spare account was not given the conversation';
         await openChat();
         const line = await ${waitFor("[...document.querySelectorAll('.chat-notice[data-state=\"switched\"]')].some(node => node.textContent?.includes('Continued on Check spare') && node.textContent?.includes('Mock Provider reached its limit') && node.textContent?.includes('Simulated account limit reached') && node.textContent?.includes('The conversation so far went along'))", 4000)};
         if (!line) return 'the chat does not show the switch';

         // Ask me: the chat offers the other account and waits for the person.
         if (await choose('Ask me') !== 'ask') return 'Settings did not keep "Ask me"';
         await sleep(Math.max(0, new Date(switched.notice.resetsAt).getTime() - Date.now()) + 300);
         messages = await send('/limit@' + spareId + ' /recall');
         if (messages?.at(-1)?.notice?.state !== 'offered') return 'no offer to go on';
         await openChat();
         const offer = await ${waitFor("[...document.querySelectorAll('.chat-notice[data-state=\"offered\"] button')].find(node => node.textContent === 'Continue on Mock Provider')", 4000)};
         if (!offer) return 'no button to go on on the other account';
         [...document.querySelectorAll('.chat-notice[data-state="offered"] button')].find(node => node.textContent === 'Continue on Mock Provider')?.click();
         // The click answers the last message again; wait for that answer.
         const clicked = Date.now();
         while (Date.now() - clicked < 15000) {
           await sleep(200);
           messages = await api.invoke('message.list', { sessionId });
           const last = messages.at(-1);
           if (last?.role === 'assistant' && last.status !== 'streaming') break;
         }
         if (messages?.at(-1)?.providerId !== 'mock' || messages.at(-1).status !== 'complete') {
           return 'the offered account did not answer: ' + messages.map(message => message.role + '/' + (message.providerId ?? '-') + '/' + message.status + ':' + message.content.slice(0, 30)).join(' | ');
         }
         if (messages.some(message => message.notice?.state === 'offered')) return 'the offer stayed open after going on';

         // Stop: the chat stops and says when the limit resets.
         if (await choose('Stop') !== 'stop') return 'Settings did not keep "Stop"';
         messages = await send('/limit@mock hello');
         const stopped = messages?.at(-1);
         if (stopped?.notice?.state !== 'stopped' || !stopped.notice.resetsAt) return 'the chat did not stop with a reset time';
         await openChat();
         return await ${waitFor("[...document.querySelectorAll('.chat-notice[data-state=\"stopped\"]')].some(node => node.textContent?.includes('off in Settings') && /Resets /.test(node.textContent ?? ''))", 4000)}
           || 'the stop is not shown with its reset time';
       } finally {
         await choose('Next account').catch(() => {});
         if (sessionId) await api.invoke('session.delete', { id: sessionId }).catch(() => {});
         await api.invoke('account.remove', { id: spare.id }).catch(() => {});
       }
     })()`,
    60_000,
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
       const card = [...document.querySelectorAll('.connector-card')]
         .find(node => node.textContent?.includes('Check skill'));
       if (!card) return 'no card for the skill';
       card.click();
       await new Promise(resolve => setTimeout(resolve, 200));
       const toggle = [...document.querySelectorAll('.connector-panel .radio-row')]
         .find(node => node.textContent?.includes('This session'))
         ?.querySelector('input');
       if (!toggle || toggle.disabled) return 'no session switch';
       // The resume run finds it already on, and must not switch it off.
       if (!toggle.checked) {
         toggle.click();
         await new Promise(resolve => setTimeout(resolve, 400));
       }
       document.querySelector('.connector-panel__close')?.click();

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

  const typeInto = `const type = (input, value) => {
       const proto = input.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
       Object.getOwnPropertyDescriptor(proto, 'value').set.call(input, value);
       input.dispatchEvent(new Event('input', { bubbles: true }));
     };`;
  await check(
    "a skill is written by hand, saved and switched on",
    `(async () => {
       ${typeInto}
       [...document.querySelectorAll('.sidebar__foot .row')]
         .find(row => row.textContent?.includes('Skills'))?.click();
       await new Promise(resolve => setTimeout(resolve, 300));
       [...document.querySelectorAll('.connectors__header .primary-button')]
         .find(node => node.textContent?.includes('New skill'))?.click();
       await new Promise(resolve => setTimeout(resolve, 200));
       const panel = document.querySelector('.connector-panel');
       if (!panel) return 'no editor';
       const [name, description] = panel.querySelectorAll('input.text-input');
       type(name, 'Check commits');
       type(description, 'Use when committing');
       type(panel.querySelector('textarea'), 'Write the why, not only the what.');
       [...panel.querySelectorAll('.primary-button')].find(node => node.textContent === 'Save skill')?.click();
       const saved = await ${waitFor("[...document.querySelectorAll('.connector-card')].some(node => node.textContent?.includes('Check commits') && node.textContent?.includes('On everywhere'))", 4000)};
       if (!saved) return 'no card for the skill';
       const skill = (await window.workbench.invoke('skill.list', undefined)).find(entry => entry.name === 'Check commits');
       return skill?.source?.kind === 'authored' && skill.instructions === 'Write the why, not only the what.'
         ? true : JSON.stringify(skill);
     })()`,
  );

  await check(
    "a skill is drafted on the chosen tool and model, shown for review, not saved",
    `(async () => {
       ${typeInto}
       const before = (await window.workbench.invoke('skill.list', undefined)).length;
       const open = async () => {
         [...document.querySelectorAll('.sidebar__foot .row')]
           .find(row => row.textContent?.includes('Skills'))?.click();
         await ${waitFor("[...document.querySelectorAll('.view__title')].some(node => node.textContent === 'Skills')", 2000)};
         document.querySelector('.connector-panel__close')?.click();
         await new Promise(resolve => setTimeout(resolve, 100));
         [...document.querySelectorAll('.connectors__header .ghost-button')]
           .find(node => node.textContent?.includes('Draft with AI'))?.click();
         return ${waitFor("document.querySelector('.connector-panel textarea')", 2000)};
       };
       if (!(await open())) return 'the draft panel did not open';
       const panel = document.querySelector('.connector-panel');
       [...panel.querySelectorAll('.draft-choice .tool-chip')].find(node => node.textContent?.includes('Mock'))?.click();
       await new Promise(resolve => setTimeout(resolve, 50));
       // The model, not only the tool.
       const model = panel.querySelector('.draft-choice select[aria-label="Model"]');
       if (!model) return 'no model choice';
       const setSelect = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set;
       setSelect.call(model, 'mock-fast');
       model.dispatchEvent(new Event('change', { bubbles: true }));
       await new Promise(resolve => setTimeout(resolve, 50));
       type(panel.querySelector('textarea'), 'Explain every shell command before running it');
       await new Promise(resolve => setTimeout(resolve, 50));
       [...panel.querySelectorAll('.primary-button')].find(node => node.textContent === 'Draft')?.click();
       const drafted = await ${waitFor("document.querySelector('.connector-panel__publisher')?.textContent?.startsWith('Drafted by')", 15000)};
       if (!drafted) return 'no draft: ' + document.querySelector('.connector-panel')?.textContent;
       const text = document.querySelector('.connector-panel textarea')?.value ?? '';
       const by = document.querySelector('.connector-panel__publisher')?.textContent ?? '';
       const after = (await window.workbench.invoke('skill.list', undefined)).length;
       document.querySelector('.connector-panel__close')?.click();
       if (!text.includes('Mock response from mock-fast')) return 'not written by the chosen model: ' + text.slice(0, 80);
       if (!by.includes('Mock Fast')) return 'the draft does not name its model: ' + by;
       if (after !== before) return 'the draft was saved';
       // The choice is remembered for the next draft.
       if (!(await open())) return 'the draft panel did not open again';
       const again = document.querySelector('.connector-panel .draft-choice select[aria-label="Model"]')?.value;
       document.querySelector('.connector-panel__close')?.click();
       return again === 'mock-fast' || 'the model was not remembered: ' + again;
     })()`,
    30_000,
  );

  // A skill Claude Code keeps for a project: in the check workspace's own
  // .claude/skills, removed again once it has been imported.
  const projectSkills = join(workspaceDirectory, ".claude", "skills");
  await mkdir(join(projectSkills, "careful-reviews"), { recursive: true });
  await writeFile(
    join(projectSkills, "careful-reviews", "SKILL.md"),
    "---\nname: Careful reviews\ndescription: Use when reviewing a change\n---\nRead the whole change first.\n",
  );
  await check(
    "skills a tool keeps are offered and imported for every tool",
    `(async () => {
       // The project's own skills are looked for in the open workspace.
       [...document.querySelectorAll('.sidebar__scroll .row')]
         .find(node => node.textContent?.includes('Check workspace'))?.click();
       await new Promise(resolve => setTimeout(resolve, 300));
       [...document.querySelectorAll('.sidebar__foot .row')]
         .find(row => row.textContent?.includes('Skills'))?.click();
       await new Promise(resolve => setTimeout(resolve, 300));
       [...document.querySelectorAll('.connectors__header .ghost-button')]
         .find(node => node.textContent?.includes('Import'))?.click();
       await new Promise(resolve => setTimeout(resolve, 100));
       [...document.querySelectorAll('.menu button')].find(node => node.textContent?.startsWith('From your tools'))?.click();
       const listed = await ${waitFor("[...document.querySelectorAll('.connector-panel .radio-row')].some(node => node.textContent?.includes('Careful reviews'))", 15000)};
       if (!listed) return 'not offered: ' + document.querySelector('.connector-panel')?.textContent;
       const row = [...document.querySelectorAll('.connector-panel .radio-row')].find(node => node.textContent?.includes('Careful reviews'));
       row.querySelector('input').click();
       await new Promise(resolve => setTimeout(resolve, 50));
       [...document.querySelectorAll('.connector-panel .primary-button')].find(node => node.textContent?.startsWith('Import'))?.click();
       const imported = await ${waitFor("[...document.querySelectorAll('.connector-card')].some(node => node.textContent?.includes('Careful reviews'))", 5000)};
       if (!imported) return 'not imported';
       const skill = (await window.workbench.invoke('skill.list', undefined)).find(entry => entry.name === 'Careful reviews');
       return skill?.instructions === 'Read the whole change first.' ? true : JSON.stringify(skill);
     })()`,
    30_000,
  );
  await rm(join(workspaceDirectory, ".claude"), { recursive: true, force: true });

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
         .find(row => row.textContent?.includes('Connectors'))?.click();
       await new Promise(resolve => setTimeout(resolve, 400));
       [...document.querySelectorAll('.segmented__item')]
         .find(node => node.textContent?.startsWith('Yours'))?.click();
       await new Promise(resolve => setTimeout(resolve, 300));
       const card = [...document.querySelectorAll('.connector-card')]
         .find(node => node.textContent?.includes('Check missing server'));
       return Boolean(card?.querySelector('.connector-card__state[data-tone="error"]'));
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

  // A server one of the person's tools is configured with — here Claude
  // Code's project file — imported once, and from then on everyone's: it
  // connects, a solo session gets its tools, and so do the built-in skills.
  // A tiny MCP server over stdio, written out so it needs nothing installed.
  const toolServer = join(workspaceDirectory, "check-tool-server.cjs");
  await writeFile(
    toolServer,
    `const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
require("node:readline").createInterface({ input: process.stdin }).on("line", (line) => {
  let message;
  try { message = JSON.parse(line); } catch { return; }
  if (message.id === undefined) return;
  const reply = (result) => send({ jsonrpc: "2.0", id: message.id, result });
  if (message.method === "initialize") {
    reply({ protocolVersion: message.params.protocolVersion, capabilities: { tools: {} },
      serverInfo: { name: "check-tool-server", version: "1.0.0" } });
  } else if (message.method === "tools/list") {
    // Its tool's name says whether the secret variable reached the process.
    const keyed = process.env.CHECK_API_TOKEN === "check-secret-value" ? "_with_token" : "_without_token";
    reply({ tools: [{ name: "check_lookup" + keyed, description: "Looks something up for the startup check",
      inputSchema: { type: "object", properties: {} } }] });
  } else if (message.method === "tools/call") {
    reply({ content: [{ type: "text", text: "looked up" }] });
  } else {
    reply({});
  }
});
`,
  );
  await writeFile(
    join(workspaceDirectory, ".mcp.json"),
    JSON.stringify({
      mcpServers: {
        "check-tool-server": {
          command: process.execPath,
          args: [toolServer],
          env: { ELECTRON_RUN_AS_NODE: "1", CHECK_API_TOKEN: "check-secret-value" },
        },
      },
    }),
  );
  await check(
    "a server imported from a tool connects, and sessions get its tools and the skills",
    `(async () => {
       const api = window.workbench;
       const workspaceId = window.__checkWorkspaceId;
       const found = (await api.invoke('mcp.discover', { workspaceId }))
         .find(entry => entry.name === 'check-tool-server');
       if (!found) return "the tool's server is not offered";
       const result = await api.invoke('mcp.importDiscovered', { keys: [found.key], workspaceId });
       const server = result.imported[0];
       if (!server) return 'not imported: ' + JSON.stringify(result.failed);
       window.__checkImportedServerId = server.id;
       if (server.availability !== 'everywhere' || !server.enabled) return 'imported for ' + server.availability;
       // The secret variable went into secure storage: named, never shown.
       if (!server.secretEnv?.CHECK_API_TOKEN) return 'the secret was not kept securely: ' + JSON.stringify(server.secretEnv);
       if ('CHECK_API_TOKEN' in server.env) return 'the secret was saved as a plain variable';
       const everything = JSON.stringify([result, await api.invoke('mcp.list', undefined), await api.invoke('mcp.discover', { workspaceId })]);
       if (everything.includes('check-secret-value')) return 'the window received the secret';

       // It is up — started with the secret — and so is the built-in skills server.
       const statuses = await api.invoke('mcp.statuses', undefined);
       const imported = statuses.find(status => status.id === server.id);
       const skills = statuses.find(status => status.id === 'ai-workbench-skills');
       if (imported?.state !== 'connected') return 'the imported server is ' + imported?.state + ': ' + imported?.detail;
       if (!imported.tools.some(tool => tool.name === 'check_lookup_with_token')) {
         return 'the server did not get its secret: ' + imported.tools.map(tool => tool.name).join(', ');
       }
       if (skills?.state !== 'connected') return 'the skills server is ' + skills?.state + ': ' + skills?.detail;
       if (!skills.tools?.some(tool => tool.name === 'skill_read')) return 'the skills server offers no skill_read';

       // A session — a new one, as anyone would open — is handed both.
       const session = await api.invoke('session.create', {
         workspaceId, name: 'Tools check session', type: 'solo', providerId: 'mock',
       });
       try {
         await api.invoke('session.sendMessage', { sessionId: session.id, text: '/context' });
         const deadline = Date.now() + 15000;
         let reply = '';
         while (Date.now() < deadline && !reply) {
           await new Promise(resolve => setTimeout(resolve, 200));
           const messages = await api.invoke('message.list', { sessionId: session.id });
           reply = messages.find(message => message.role === 'assistant' && (message.content ?? '').includes('Tools available'))?.content ?? '';
         }
         if (!reply.includes('check_lookup_with_token')) return 'the session did not get the imported tool: ' + reply.slice(-300);
         if (reply.includes('check-secret-value')) return 'the session was handed the secret';
         if (!reply.includes('skill_read')) return 'the session did not get the skills: ' + reply.slice(-300);
         return true;
       } finally {
         await api.invoke('session.delete', { id: session.id }).catch(() => {});
       }
     })()`,
    40_000,
  );

  // The tool's configuration changes: the import offers the update, and
  // taken into this workspace only, the same server is updated in place.
  await writeFile(
    join(workspaceDirectory, ".mcp.json"),
    JSON.stringify({
      mcpServers: {
        "check-tool-server": {
          command: process.execPath,
          args: [toolServer],
          env: { ELECTRON_RUN_AS_NODE: "1", CHECK_API_TOKEN: "check-secret-value", CHECK_MODE: "changed" },
        },
      },
    }),
  );
  await check(
    "a server changed at its source is offered as an update, and can be kept to one workspace",
    `(async () => {
       const api = window.workbench;
       const workspaceId = window.__checkWorkspaceId;
       const id = window.__checkImportedServerId;
       const found = (await api.invoke('mcp.discover', { workspaceId })).find(entry => entry.name === 'check-tool-server');
       if (!found) return 'the server is no longer offered';
       if (!found.imported || !found.changed) return 'the change is not offered: ' + JSON.stringify({ imported: found.imported, changed: found.changed });
       const result = await api.invoke('mcp.importDiscovered', { keys: [found.key], workspaceId, scope: 'workspace' });
       const server = result.imported[0];
       if (!server) return 'not updated: ' + JSON.stringify(result.failed);
       if (server.id !== id) return 'imported again as ' + server.id + ' instead of updating ' + id;
       if (server.env.CHECK_MODE !== 'changed') return 'the change was not taken over';
       if (server.availability !== 'workspaces' || server.workspaceIds.join() !== workspaceId) return 'not kept to the workspace';
       const again = (await api.invoke('mcp.discover', { workspaceId })).find(entry => entry.name === 'check-tool-server');
       return again?.changed === false || 'still offered as changed';
     })()`,
    30_000,
  );

  // A team member gets its skills too — here on a tool without MCP, so they
  // must come as instructions. The goal asks the stand-in to say what it was
  // given instead of working; the run is cancelled after its first turn.
  await check(
    "a team member gets the skills that are on, whatever its tool",
    `(async () => {
       const api = window.workbench;
       const workspaceId = window.__checkWorkspaceId;
       const team = (await api.invoke('team.list', { workspaceId })).find(entry => entry.name === 'Skills check team')
         ?? await api.invoke('team.create', {
           workspaceId,
           name: 'Skills check team',
           agents: [{ displayName: 'Lead', providerId: 'mock', role: 'plans', skills: [], plugins: [], mcpServers: [], settings: {} }],
         });
       const run = await api.invoke('team.startRun', { teamId: team.id, goal: 'Say what you were given: /context', workspaceId });
       try {
         const deadline = Date.now() + 20000;
         let output = '';
         // Read once the first turn is over: while it runs its output is
         // written in steps and may not be complete yet.
         while (Date.now() < deadline) {
           await new Promise(resolve => setTimeout(resolve, 200));
           const snapshot = await api.invoke('team.getRun', { runId: run.id });
           const done = snapshot.turns.filter(turn => turn.status !== 'running');
           output = done.map(turn => turn.output ?? '').join('\\n');
           if (output.includes('Instructions received')) break;
         }
         if (!output.includes('Instructions received')) return 'no turn said what it was given';
         // "Check commits" is on everywhere (switched on in an earlier check).
         return output.includes('Write the why, not only the what.')
           || 'the member did not get the skill: ' + output.slice(0, 300);
       } finally {
         await api.invoke('team.cancelRun', { runId: run.id }).catch(() => {});
       }
     })()`,
    30_000,
  );
  await check(
    "the imported server is removed again",
    `(async () => {
       const id = window.__checkImportedServerId;
       if (!id) return true;
       const { deleted } = await window.workbench.invoke('mcp.delete', { id });
       return deleted;
     })()`,
  );
  await rm(join(workspaceDirectory, ".mcp.json"), { force: true });

  await check(
    "the connector catalog lists services and says how each signs in",
    `(async () => {
       [...document.querySelectorAll('.sidebar__foot .row')]
         .find(row => row.textContent?.includes('Connectors'))?.click();
       await new Promise(resolve => setTimeout(resolve, 300));
       [...document.querySelectorAll('.segmented__item')]
         .find(node => node.textContent === 'Discover')?.click();
       await new Promise(resolve => setTimeout(resolve, 300));
       const cards = [...document.querySelectorAll('.connector-card')];
       if (cards.length < 10) return 'only ' + cards.length + ' services';
       cards.find(node => node.textContent?.includes('Gmail'))?.click();
       const opened = await ${waitFor("document.querySelector('.connector-panel')?.textContent?.includes('OAuth client ID')", 2000)};
       if (!opened) return 'the Gmail panel does not ask for its OAuth client';
       const facts = document.querySelector('.connector-facts')?.textContent ?? '';
       document.querySelector('.connector-panel__close')?.click();
       return facts.includes('Answered from AI Workbench') ? true : 'no test date: ' + facts;
     })()`,
  );

  // A service behind OAuth, the way MCP specifies it, started in this
  // process: the connector is added and signed in to through the screen,
  // and its tools come through the gateway that keeps the token.
  const oauthService = await import("@ai-workbench/test-support").then((support) =>
    support.startOAuthMcpTestServer(),
  );
  await check(
    "a connector added by hand signs in with OAuth and offers its tools",
    `(async () => {
       [...document.querySelectorAll('.sidebar__foot .row')]
         .find(row => row.textContent?.includes('Connectors'))?.click();
       await new Promise(resolve => setTimeout(resolve, 300));
       [...document.querySelectorAll('.connectors__header .primary-button')]
         .find(node => node.textContent?.includes('Add'))?.click();
       await new Promise(resolve => setTimeout(resolve, 300));
       const panel = document.querySelector('.connector-panel');
       if (!panel) return 'no form';
       const type = (input, value) => {
         const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
         setter.call(input, value);
         input.dispatchEvent(new Event('input', { bubbles: true }));
       };
       const inputs = [...panel.querySelectorAll('input.text-input')];
       type(inputs[0], 'Check notes');
       type(inputs[1], ${JSON.stringify(oauthService.url)});
       [...panel.querySelectorAll('.segmented__item')]
         .find(node => node.textContent === 'Sign in (OAuth)')?.click();
       await new Promise(resolve => setTimeout(resolve, 100));
       [...panel.querySelectorAll('.primary-button')]
         .find(node => node.textContent === 'Add connector')?.click();
       const connected = await ${waitFor(
         "document.querySelector('.connector-panel__status')?.textContent?.includes('Connected · 1 tool')",
         15000,
       )};
       if (!connected) return 'status: ' + (document.querySelector('.connector-panel')?.textContent ?? 'no panel');
       const [server] = (await window.workbench.invoke('mcp.list', undefined)).filter(entry => entry.name === 'Check notes');
       const status = (await window.workbench.invoke('mcp.statuses', undefined)).find(entry => entry.id === server?.id);
       document.querySelector('.connector-panel__close')?.click();
       // Only a reference to the sign-in is stored with the connector.
       const passed = server?.oauth?.reference && !JSON.stringify(server).includes('access_token')
         && status?.tools?.[0]?.name === 'read_note';
       // The service lives only as long as this run; so does the connector.
       if (server) await window.workbench.invoke('mcp.delete', { id: server.id });
       return passed ? true : JSON.stringify({ server, status });
     })()`,
    30_000,
  );
  await oauthService.close();

  await check(
    "connecting an account never falls back to plaintext",
    `(async () => {

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

  // A team picked in a session of another workspace works there, starts once,
  // and the session shows it working: members, feed, where it writes.
  const teamSpace = join(workspaceDirectory, "team-space");
  await mkdir(teamSpace, { recursive: true });
  await check(
    "a team picked in a session works in that session's workspace",
    `(async () => {
       const api = window.workbench;
       const folder = ${JSON.stringify(teamSpace)};
       const workspace = (await api.invoke('workspace.list', undefined))
         .find(entry => entry.path === folder)
         ?? await api.invoke('workspace.create', { name: 'Team space', path: folder });
       const session = (await api.invoke('session.list', { workspaceId: workspace.id }))
         .find(entry => entry.name === 'Team session')
         ?? await api.invoke('session.create', {
           workspaceId: workspace.id, name: 'Team session', type: 'solo', providerId: 'mock',
         });
       await new Promise(resolve => setTimeout(resolve, 400));
       const row = [...document.querySelectorAll('.sidebar__scroll .row')]
         .find(node => node.textContent?.includes('Team space'));
       if (!row) return 'no sidebar row for the workspace';
       row.click();
       await new Promise(resolve => setTimeout(resolve, 600));
       [...document.querySelectorAll('.sidebar__scroll .row')]
         .find(node => node.querySelector('.row__text')?.textContent === 'Team session')?.click();
       await new Promise(resolve => setTimeout(resolve, 400));

       // The model pill offers the team; picking it puts the team in the session.
       const pill = document.querySelector('.composer .popover > .pill');
       if (!pill) return 'no model pill';
       pill.click();
       await new Promise(resolve => setTimeout(resolve, 400));
       const option = [...document.querySelectorAll('.popover__panel [role="option"]')]
         .find(node => node.textContent?.includes('Check team'));
       if (!option) return 'the picker does not offer the team';
       option.click();
       if (!(await ${waitFor("document.querySelector('.team-intro, .team-run')", 4000)})) return 'no team view';

       // A goal from the box starts one run, in this workspace.
       const goal = 'Check the team works in its session ' + Date.now();
       const box = document.querySelector('.composer__input');
       const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
       setter.call(box, goal);
       box.dispatchEvent(new Event('input', { bubbles: true }));
       box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));

       const team = (await api.invoke('team.list', {})).find(entry => entry.name === 'Check team');
       let runs = [];
       const deadline = Date.now() + 25000;
       while (Date.now() < deadline) {
         await new Promise(resolve => setTimeout(resolve, 300));
         runs = (await api.invoke('team.listRuns', { teamId: team.id })).filter(run => run.goal === goal);
         if (runs.length > 0 && runs.every(run => run.status !== 'running' && run.status !== 'pending')) break;
       }
       if (runs.length !== 1) return runs.length + ' runs started for one goal';
       if (runs[0].workspaceId !== workspace.id) return 'the run is not in the session workspace';
       if (runs[0].status !== 'completed') return 'the run ended ' + runs[0].status;

       await new Promise(resolve => setTimeout(resolve, 3500));
       const entries = document.querySelectorAll('.team-entry').length;
       const members = document.querySelectorAll('.team-roster__member').length;
       const path = document.querySelector('.team-run__path')?.textContent;
       if (entries === 0) return 'the feed is empty';
       if (members !== 3) return members + ' members in the roster';
       if (path !== folder) return 'works in ' + path;
       window.__checkTeamSessionId = session.id;
       // Back to the check's own workspace for the checks after this one.
       [...document.querySelectorAll('.sidebar__scroll .row')]
         .find(node => node.textContent?.includes('Check workspace'))?.click();
       await new Promise(resolve => setTimeout(resolve, 600));
       return true;
     })()`,
    40_000,
  );

  // A second session in the same workspace starts the team fresh: none of the
  // first session's run shows, and its goal starts a run of its own — the
  // other session's tasks, messages and provider sessions stay with it.
  await check(
    "a new session in the same workspace starts the team without the other session's run",
    `(async () => {
       const api = window.workbench;
       const folder = ${JSON.stringify(teamSpace)};
       const workspace = (await api.invoke('workspace.list', undefined))
         .find(entry => entry.path === folder);
       const firstId = window.__checkTeamSessionId;
       if (!workspace || !firstId) return 'the team session check did not run';
       const firstRunId = (await api.invoke('session.list', { workspaceId: workspace.id }))
         .find(entry => entry.id === firstId)?.uiState.teamRunId;
       if (!firstRunId) return 'the first session shows no run';
       const fresh = await api.invoke('session.create', {
         workspaceId: workspace.id, name: 'Fresh team session', type: 'solo', providerId: 'mock',
       });
       const rows = () => [...document.querySelectorAll('.sidebar__scroll .row')];
       try {
         rows().find(node => node.textContent?.includes('Team space'))?.click();
         await new Promise(resolve => setTimeout(resolve, 600));
         const row = rows().find(node => node.querySelector('.row__text')?.textContent === 'Fresh team session');
         if (!row) return 'no sidebar row for the new session';
         row.click();
         await new Promise(resolve => setTimeout(resolve, 500));

         document.querySelector('.composer .popover > .pill')?.click();
         await new Promise(resolve => setTimeout(resolve, 400));
         const option = [...document.querySelectorAll('.popover__panel [role="option"]')]
           .find(node => node.textContent?.includes('Check team'));
         if (!option) return 'the picker does not offer the team';
         option.click();
         if (!(await ${waitFor("Boolean(document.querySelector('.team-intro'))", 4000)})) {
           return 'the new session opened on ' + (document.querySelector('.team-run')?.textContent?.slice(0, 80) ?? 'nothing');
         }
         const picked = (await api.invoke('session.list', { workspaceId: workspace.id }))
           .find(entry => entry.id === fresh.id);
         if (picked?.uiState.teamRunId) return 'the new session took run ' + picked.uiState.teamRunId;

         const goal = 'Check a new session starts fresh ' + Date.now();
         const box = document.querySelector('.composer__input');
         const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
         setter.call(box, goal);
         box.dispatchEvent(new Event('input', { bubbles: true }));
         box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));

         const team = (await api.invoke('team.list', {})).find(entry => entry.name === 'Check team');
         let runs = [];
         const deadline = Date.now() + 25000;
         while (Date.now() < deadline) {
           await new Promise(resolve => setTimeout(resolve, 300));
           runs = (await api.invoke('team.listRuns', { teamId: team.id })).filter(run => run.goal === goal);
           if (runs.length > 0 && runs.every(run => run.status !== 'running' && run.status !== 'pending')) break;
         }
         if (runs.length !== 1) return runs.length + ' runs for the new goal';
         if (runs[0].id === firstRunId) return "the goal continued the other session's run";
         if (runs[0].sessionId !== fresh.id) return 'the run belongs to ' + runs[0].sessionId;
         if (runs[0].workspaceId !== workspace.id) return 'the run is not in the session workspace';
         if (runs[0].status !== 'completed') return 'the run ended ' + runs[0].status;
         const first = await api.invoke('team.getRun', { runId: firstRunId });
         if (first.messages.some(message => message.content === goal)) return "the goal reached the other session's run";
         const own = await api.invoke('team.getRun', { runId: runs[0].id });
         if (own.messages.some(message => first.messages.some(old => old.id === message.id))) {
           return "the new run carries the other session's messages";
         }
         return true;
       } finally {
         await api.invoke('session.delete', { id: fresh.id }).catch(() => {});
         rows().find(node => node.textContent?.includes('Check workspace'))?.click();
         await new Promise(resolve => setTimeout(resolve, 600));
       }
     })()`,
    40_000,
  );

  // What a member's turn changed shows in the session as a diff, read from
  // the folder itself — here a git folder where the stand-in member writes a
  // file — and the person's own git index is left exactly as it was.
  const diffSpace = join(workspaceDirectory, "diff-space");
  await mkdir(diffSpace, { recursive: true });
  const gitIn = async (...args: string[]): Promise<string> => {
    const { stdout, exit } = await execCli({ executablePath: "git", args, cwd: diffSpace });
    if (exit.code !== 0) {
      throw new Error(`git ${args.join(" ")}: ${exit.stderr}`);
    }
    return stdout;
  };
  // A repository of its own, even inside another one.
  const gitReady = await readFile(join(diffSpace, ".git", "HEAD"), "utf8")
    .then(() => true)
    .catch(async () => {
      await gitIn("init", "--initial-branch", "main");
      await gitIn("config", "user.email", "check@example.com");
      await gitIn("config", "user.name", "Check");
      await writeFile(join(diffSpace, "README.md"), "diff space\n");
      await gitIn("add", ".");
      await gitIn("commit", "-m", "start");
      return true;
    })
    .catch(() => false);
  if (gitReady) {
    const feature = `src/feature-${Date.now()}.ts`;
    await check(
      "a member's code changes show in the session as a diff",
      `(async () => {
         const api = window.workbench;
         const folder = ${JSON.stringify(diffSpace)};
         const workspace = (await api.invoke('workspace.list', undefined)).find(entry => entry.path === folder)
           ?? await api.invoke('workspace.create', { name: 'Diff space', path: folder });
         // A new session each time, so the goal starts a run of its own. One
         // member does the work, so each change is its own alone.
         const session = await api.invoke('session.create', {
           workspaceId: workspace.id, name: 'Diff session', type: 'solo', providerId: 'mock',
         });
         const pair = (await api.invoke('team.list', {})).find(entry => entry.name === 'Diff check team')
           ?? await api.invoke('team.create', {
             workspaceId: workspace.id,
             name: 'Diff check team',
             agents: [
               { displayName: 'Lead', providerId: 'mock', role: 'plans', skills: [], plugins: [], mcpServers: [], settings: {} },
               { displayName: 'Builder', providerId: 'mock', role: 'implements', skills: [], plugins: [], mcpServers: [], settings: {} },
             ],
           });
         const rows = () => [...document.querySelectorAll('.sidebar__scroll .row')];
         try {
           await new Promise(resolve => setTimeout(resolve, 300));
           rows().find(node => node.textContent?.includes('Diff space'))?.click();
           await new Promise(resolve => setTimeout(resolve, 600));
           rows().find(node => node.querySelector('.row__text')?.textContent === 'Diff session')?.click();
           await new Promise(resolve => setTimeout(resolve, 400));
           if (!document.querySelector('.team-intro, .team-run')) {
             document.querySelector('.composer .popover > .pill')?.click();
             await new Promise(resolve => setTimeout(resolve, 400));
             [...document.querySelectorAll('.popover__panel [role="option"]')]
               .find(node => node.textContent?.includes('Diff check team'))?.click();
             if (!(await ${waitFor("document.querySelector('.team-intro, .team-run')", 4000)})) return 'no team view';
           }
           const goal = 'Add the feature [write: ${feature}]';
           const box = document.querySelector('.composer__input');
           Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(box, goal);
           box.dispatchEvent(new Event('input', { bubbles: true }));
           box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));

           let run = null;
           const deadline = Date.now() + 25000;
           while (Date.now() < deadline) {
             await new Promise(resolve => setTimeout(resolve, 300));
             run = (await api.invoke('team.listRuns', { teamId: pair.id })).find(entry => entry.goal === goal) ?? null;
             if (run && run.status !== 'running' && run.status !== 'pending') break;
           }
           if (!run) return 'no run for the goal';
           if (run.status !== 'completed') return 'the run ended ' + run.status;
           const shown = await ${waitFor(`[...document.querySelectorAll('.team-file[data-artifact-kind="diff"]')].some(node => node.textContent?.includes('${feature}') && [...node.querySelectorAll('.diff-preview__line[data-kind="add"]')].some(line => line.textContent?.includes('export const done = true;')))`, 8000)};
           if (!shown) {
             const snapshot = await api.invoke('team.getRun', { runId: run.id });
             return 'no diff shown; artifacts: ' + snapshot.artifacts.map(item => item.type + ':' + (item.path ?? item.name)).join(', ');
           }
           document.querySelector('.team-file[data-artifact-kind="diff"]')?.scrollIntoView({ block: 'center' });
           return true;
         } finally {
           window.__checkDiffSessionId = session.id;
         }
       })()`,
      40_000,
    );
    // Evidence for a person, when screenshots are asked for: the diff as the
    // session shows it.
    const diffShot = process.env["AI_WORKBENCH_CHECK_SCREENSHOT"];
    if (diffShot) {
      await new Promise((resolve) => setTimeout(resolve, 300));
      await writeFile(diffShot.replace(/\.png$/, "-team-diff.png"), (await window.webContents.capturePage()).toPNG()).catch(
        () => undefined,
      );
    }
    await window.webContents.executeJavaScript(`(async () => {
      const id = window.__checkDiffSessionId;
      if (id) await window.workbench.invoke('session.delete', { id }).catch(() => {});
      [...document.querySelectorAll('.sidebar__scroll .row')]
        .find(node => node.textContent?.includes('Check workspace'))?.click();
      await new Promise(resolve => setTimeout(resolve, 600));
    })()`);
    // The member's file is there as the person would find it: new and not
    // staged — the application's snapshots never touched the index.
    const porcelain = await gitIn("status", "--porcelain", "--untracked-files=all").catch(() => "");
    const staged = porcelain.split("\n").filter((line) => line.length > 1 && line[0] !== " " && line[0] !== "?");
    outcomes.push({
      name: "watching a turn leaves the person's git index untouched",
      passed: porcelain.includes(`?? ${feature}`) && staged.length === 0,
      detail: porcelain.trim() || "clean",
    });
  }

  // A team made in the editor from a template: its members arrive with the
  // template's roles and each with instructions of its own, the lead first.
  await check(
    "a team made from a template in the editor keeps each member's role and instructions",
    `(async () => {
       const api = window.workbench;
       [...document.querySelectorAll('.sidebar__foot .row')]
         .find(node => node.textContent?.includes('Teams'))?.click();
       await new Promise(resolve => setTimeout(resolve, 500));
       [...document.querySelectorAll('button')]
         .find(node => node.textContent?.trim().endsWith('New team'))?.click();
       await new Promise(resolve => setTimeout(resolve, 400));
       const template = [...document.querySelectorAll('.team-template')]
         .find(node => node.textContent?.includes('Bug fixing'));
       if (!template) return 'no templates';
       template.click();
       await new Promise(resolve => setTimeout(resolve, 200));
       const cards = document.querySelectorAll('.member-card');
       const chips = document.querySelectorAll('.member-card .tool-chip .logo').length;
       const name = document.querySelector('.team-editor__name');
       const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
       setter.call(name, 'Check template team');
       name.dispatchEvent(new Event('input', { bubbles: true }));
       await new Promise(resolve => setTimeout(resolve, 100));
       [...document.querySelectorAll('.team-editor__actions button')]
         .find(node => node.textContent?.trim() === 'Create team')?.click();
       const deadline = Date.now() + 5000;
       let team = null;
       while (Date.now() < deadline && !team) {
         await new Promise(resolve => setTimeout(resolve, 200));
         team = (await api.invoke('team.list', {})).find(entry => entry.name === 'Check template team') ?? null;
       }
       if (!team) return 'the team was not created';
       const roles = team.agents.map(agent => agent.displayName).join('|');
       const instructed = team.agents.every(agent =>
         typeof agent.settings.instructions === 'string' && agent.settings.instructions.length > 80);
       const lead = team.agents.find(agent => agent.id === team.leadAgentId)?.displayName;
       await api.invoke('team.delete', { teamId: team.id });
       return (cards.length === 3 && chips >= 3 && roles === 'Lead|Debugger|Tester' && instructed && lead === 'Lead')
         || JSON.stringify({ cards: cards.length, chips, roles, instructed, lead });
     })()`,
  );

  // --- status island: widgets, priority, deep links ---------------------------

  await check(
    "a finished run is reported as completed work",
    `(async () => {
       const state = await window.workbench.invoke('statusIsland.getState', undefined);
       const entry = state.entries.find(item => item.widget === 'completedWork');
       if (!entry) return false;
       // The run that finished last: a finished run that gets its next goal
       // keeps its place in the list but finishes again.
       const runs = await window.workbench.invoke('team.listRuns', {});
       const run = runs
         .filter(item => item.status === 'completed' && item.finishedAt)
         .sort((left, right) => new Date(right.finishedAt).getTime() - new Date(left.finishedAt).getTime())[0];
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
  // Every theme is chosen the way a person does it, from the picker in
  // Settings, in both of its modes, and must then repaint the whole window
  // readably, with its own typeface actually loaded from the app (fonts
  // ship inside it; the page's policy allows nothing from outside).
  await check(
    "every theme can be picked in Settings, light and dark, and repaints the window readably",
    `(async () => {
       await ${waitFor("document.querySelector('.sidebar__foot')")};
       [...document.querySelectorAll('.sidebar__foot .row')]
         .find(node => node.textContent?.includes('Settings'))?.click();
       await ${waitFor("document.querySelector('.theme-picker__trigger')")};
       const rgba = (value) => {
         const [r = 0, g = 0, b = 0, a = 1] = (value.match(/[\\d.]+/g) ?? []).map(Number);
         return [r, g, b, value.startsWith('rgba') ? a : 1];
       };
       const over = (top, bottom) => top.map((c, i) => i < 3 ? c * top[3] + bottom[i] * (1 - top[3]) : 1);
       const lum = ([r, g, b]) => [r, g, b]
         .map(c => { const s = c / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; })
         .reduce((sum, c, i) => sum + c * [0.2126, 0.7152, 0.0722][i], 0);
       const contrast = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
       const settle = () => new Promise(resolve => setTimeout(resolve, 350));
       const pickTheme = async (index) => {
         document.querySelector('.theme-picker__trigger').click();
         await new Promise(resolve => setTimeout(resolve, 150));
         const option = document.querySelectorAll('.theme-picker__option')[index];
         const name = option?.querySelector('.theme-picker__option-name')?.textContent ?? '';
         option?.click();
         await settle();
         return name;
       };
       const pickMode = async (label) => {
         [...document.querySelectorAll('.segmented__item')]
           .find(node => node.textContent?.trim() === label)?.click();
         await settle();
       };
       document.querySelector('.theme-picker__trigger').click();
       await new Promise(resolve => setTimeout(resolve, 150));
       const count = document.querySelectorAll('.theme-picker__option').length;
       document.querySelector('.theme-picker__trigger').click();
       const problems = [];
       const drawn = [];
       for (let index = 0; index < count; index += 1) {
         const name = await pickTheme(index);
         for (const mode of ['Light', 'Dark']) {
           await pickMode(mode);
           const theme = document.documentElement.dataset.theme;
           drawn.push(theme);
           const scheme = getComputedStyle(document.documentElement).colorScheme;
           if (scheme !== mode.toLowerCase()) problems.push(name + ' ' + mode + ': drawn as ' + scheme);
           const page = rgba(getComputedStyle(document.querySelector('.app')).backgroundColor);
           const text = over(rgba(getComputedStyle(document.querySelector('.view__title')).color), page);
           const sidebar = over(rgba(getComputedStyle(document.querySelector('.sidebar')).backgroundColor), page);
           const sideText = over(rgba(getComputedStyle(document.querySelector('.sidebar__title')).color), sidebar);
           if (contrast(text, page) < 7) problems.push(name + ' ' + mode + ': title contrast ' + contrast(text, page).toFixed(2));
           if (contrast(sideText, sidebar) < 7) problems.push(name + ' ' + mode + ': sidebar contrast ' + contrast(sideText, sidebar).toFixed(2));
           const display = getComputedStyle(document.querySelector('.view__title')).fontFamily
             .split(',')[0].trim().replace(/^["']|["']$/g, '');
           const ours = [...document.fonts].some(face => face.family.replace(/^["']|["']$/g, '') === display);
           if (ours) {
             await document.fonts.load('20px "' + display + '"');
             const loaded = [...document.fonts].some(face =>
               face.family.replace(/^["']|["']$/g, '') === display && face.status === 'loaded');
             if (!loaded) problems.push(name + ': ' + display + ' did not load');
           }
         }
         if (!document.querySelector('.theme-picker__trigger')?.textContent?.includes(name)) {
           problems.push(name + ': the picker does not show it as chosen');
         }
       }
       // Back to the default, so what follows sees the app as it starts.
       document.querySelector('.theme-picker__trigger').click();
       await new Promise(resolve => setTimeout(resolve, 150));
       [...document.querySelectorAll('.theme-picker__option')]
         .find(node => node.querySelector('.theme-picker__option-name')?.textContent === 'Quiet')?.click();
       await settle();
       await pickMode('System');
       // The sidebar's toggle steps System, Light, Dark and back, for any theme.
       const toggle = document.querySelector('.sidebar__head .mode-toggle-button');
       const system = matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
       const seen = [document.documentElement.dataset.theme];
       for (let step = 0; step < 3; step += 1) {
         toggle?.click();
         await settle();
         seen.push(document.documentElement.dataset.theme);
       }
       if (seen.join(',') !== [system, 'light', 'dark', system].join(',')) {
         problems.push('the mode toggle went ' + seen.join(' > '));
       }
       if (count < 6 || new Set(drawn).size !== count * 2) problems.push('drawn: ' + drawn.join(','));
       return problems.length === 0 ? true : JSON.stringify(problems);
     })()`,
    90_000,
  );

  await checkMain("the island takes on the theme and mode picked in the main window", async () => {
    const choose = (theme: string, mode: string): Promise<unknown> =>
      window.webContents.executeJavaScript(
        `(async () => {
           document.querySelector('.theme-picker__trigger')?.click();
           await new Promise(resolve => setTimeout(resolve, 150));
           [...document.querySelectorAll('.theme-picker__option')]
             .find(node => node.querySelector('.theme-picker__option-name')?.textContent === ${JSON.stringify(theme)})
             ?.click();
           await new Promise(resolve => setTimeout(resolve, 250));
           [...document.querySelectorAll('.segmented__item')]
             .find(node => node.textContent?.trim() === ${JSON.stringify(mode)})?.click();
           await new Promise(resolve => setTimeout(resolve, 300));
           return document.documentElement.dataset.theme;
         })()`,
      );
    const islandShows = async (expected: string): Promise<boolean> => {
      const deadline = Date.now() + 4000;
      while (Date.now() < deadline) {
        if ((await islandJs("document.documentElement.dataset.theme")) === expected) {
          return true;
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      return false;
    };
    // The island's ink reads on its own body, dark or light.
    const readable = (): Promise<unknown> =>
      islandJs(
        `(() => {
           const parse = (value) => (value.match(/[\\d.]+/g) ?? []).map(Number);
           const style = getComputedStyle(document.documentElement);
           const probe = document.createElement('span');
           probe.style.color = style.getPropertyValue('--island-body');
           document.body.append(probe);
           const [br = 0, bg = 0, bb = 0, ba = 1] = parse(getComputedStyle(probe).color);
           probe.remove();
           const [r = 0, g = 0, b = 0] = parse(getComputedStyle(document.body).color);
           const lum = (c) => c.map(v => { const x = v / 255; return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; })
             .reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i], 0);
           const [hi, lo] = [lum([r, g, b]), lum([br * ba, bg * ba, bb * ba])].sort((x, y) => y - x);
           return (hi + 0.05) / (lo + 0.05) >= 7;
         })()`,
      );
    const results: string[] = [];
    for (const [theme, mode, drawn] of [
      ["Atelier", "Dark", "atelier-dark"],
      ["Atelier", "Light", "atelier-light"],
      ["Playground", "Dark", "playground-dark"],
    ] as const) {
      await choose(theme, mode);
      const followed = await islandShows(drawn);
      const reads = (await readable()) === true;
      if (!followed || !reads) {
        results.push(`${drawn}: followed ${followed}, readable ${reads}`);
      }
    }
    const back = await choose("Quiet", "System");
    if (!(await islandShows(String(back)))) {
      results.push(`back to ${String(back)} did not reach the island`);
    }
    if (results.length > 0) {
      throw new Error(results.join("; "));
    }
    return true;
  });

  // Updates compare the commit a release was built from with this build's,
  // so a version published again still reaches it; the build must know its
  // own. Automatic updates are on by default and say so.
  await check(
    "the build knows the commit it was made from, and updates run in the background by default",
    `(async () => {
       const status = await window.workbench.invoke('update.getStatus', undefined);
       const settings = await window.workbench.invoke('settings.get', undefined);
       const ok = /^[0-9a-f]{7}$/.test(status.currentBuild ?? '') && settings.autoUpdate === true
         && [...document.querySelectorAll('.setting__label')].some(node => node.textContent === 'Update automatically')
           === Boolean(document.querySelector('.theme-picker'));
       return ok ? true : JSON.stringify({ build: status.currentBuild, autoUpdate: settings.autoUpdate });
     })()`,
  );

  // A downloaded update asks once, in the window and on the island, and an
  // answer in one place is the answer in both. "Restart now" is not pressed:
  // this build is not installed, so there is nothing to install over.
  await checkMain("a downloaded update asks Later or Restart now in the window and on the island", async () => {
    const waitFor = async (script: string, ms = 5_000): Promise<boolean> => {
      const until = Date.now() + ms;
      while (Date.now() < until) {
        if ((await window.webContents.executeJavaScript(script)) === true) {
          return true;
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      return false;
    };
    const prompt = `(() => {
      const card = document.querySelector('.update-prompt');
      const labels = [...(card?.querySelectorAll('button') ?? [])].map(b => b.textContent.trim());
      return Boolean(card) && labels.join('|') === 'Later|Restart now' && card.textContent.includes('9.9.9');
    })()`;
    const gone = `!document.querySelector('.update-prompt')`;
    const offered = (): string | null => {
      const entry = island.state.entries.find((candidate) => candidate.widget === "appUpdate");
      return entry && entry.options.map((option) => option.id).join("|") === "later|restart" ? entry.key : null;
    };
    try {
      simulateDownload({ version: "9.9.9", commit: "abc1234def5678abc1234def5678abc1234def56" });
      await island.refresh();
      const inWindow = await waitFor(prompt);
      const onIsland = offered() !== null;
      // Evidence for a person, when screenshots are asked for: the card in
      // the window and the island's own question.
      const shots = process.env["AI_WORKBENCH_CHECK_SCREENSHOT"];
      if (shots) {
        await mkdir(dirname(shots), { recursive: true });
        await writeFile(shots.replace(/\.png$/, "-update.png"), (await window.webContents.capturePage()).toPNG());
        window.blur();
        await new Promise((resolve) => setTimeout(resolve, 1500));
        const target = islandWindow();
        const image = target?.isVisible()
          ? await Promise.race([
              target.webContents.capturePage(),
              new Promise<null>((resolve) => setTimeout(() => resolve(null), 5000)),
            ])
          : null;
        if (image) {
          await writeFile(shots.replace(/\.png$/, "-update-island.png"), image.toPNG());
        }
        window.focus();
      }
      // Later in the window: the island stops asking too.
      await window.webContents.executeJavaScript(
        `[...document.querySelectorAll('.update-prompt button')].find(b => b.textContent.trim() === 'Later')?.click()`,
      );
      const laterInWindow = await waitFor(gone);
      await island.refresh();
      const islandFollows = offered() === null;
      // The next download asks again; Later on the island closes the window's card.
      simulateDownload({ version: "9.9.9", commit: "fedcba9876543210fedcba9876543210fedcba98" });
      await island.refresh();
      const askedAgain = (await waitFor(prompt)) && offered() !== null;
      const key = offered();
      const answered = key ? (await island.respond(key, "later")).answered : false;
      const windowFollows = await waitFor(gone);
      const result = { inWindow, onIsland, laterInWindow, islandFollows, askedAgain, answered, windowFollows };
      if (!Object.values(result).every(Boolean)) {
        throw new Error(JSON.stringify(result));
      }
      return true;
    } finally {
      simulateDownload(null);
      await island.refresh();
    }
  });

  await check(
    "the app's own mark is its logo",
    `(() => {
       const mark = document.querySelector('.sidebar__head svg.app-logo');
       return Boolean(mark) && mark.querySelectorAll('.app-logo__bar').length === 3;
     })()`,
  );

  await check(
    "returns to the session after the settings screens",
    `(async () => {
       [...document.querySelectorAll('.sidebar__scroll .row')]
         .find(node => node.textContent?.includes('Check session'))?.click();
       await new Promise(resolve => setTimeout(resolve, 400));
       return Boolean(document.querySelector('.composer'));
     })()`,
  );

  // Hovering a session shows where it works and how far it has come. A new
  // session without a single message used to take the whole window down
  // here: its line read the messages through a selector that made a new
  // list on every read, which React takes for a store that never settles.
  await check(
    "hovering a session without messages shows its details and keeps the window",
    `(async () => {
       const api = window.workbench;
       const workspaceId = window.__checkWorkspaceId;
       const rows = () => [...document.querySelectorAll('.sidebar__scroll .row')];
       rows().find(node => node.textContent?.includes('Check workspace'))?.click();
       await new Promise(resolve => setTimeout(resolve, 600));
       // Created after the workspace opened, so it is listed but was never
       // opened: nothing of it is loaded yet, which is what the crash needed.
       const fresh = await api.invoke('session.create', {
         workspaceId, name: 'Hover check session', type: 'solo', providerId: 'mock',
       });
       try {
         await new Promise(resolve => setTimeout(resolve, 400));
         const row = rows().find(node => node.querySelector('.row__text')?.textContent === 'Hover check session');
         if (!row) return 'no row for the new session';
         row.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, relatedTarget: document.body }));
         row.focus();
         await new Promise(resolve => setTimeout(resolve, 500));
         const panel = [...document.querySelectorAll('.popover__panel')]
           .find(node => node.textContent?.includes('No turns yet'));
         if (document.querySelector('.error-fallback')) {
           return 'the window fell back: ' + document.querySelector('.error-fallback')?.textContent;
         }
         if (!document.querySelector('.sidebar') || !document.querySelector('.composer')) return 'the window is gone';
         return Boolean(panel) || 'no details on hover';
       } finally {
         document.activeElement?.blur?.();
         await api.invoke('session.delete', { id: fresh.id }).catch(() => {});
         rows().find(node => node.textContent?.includes('Check workspace'))?.click();
         await new Promise(resolve => setTimeout(resolve, 400));
         rows().find(node => node.textContent?.includes('Check session'))?.click();
         await new Promise(resolve => setTimeout(resolve, 400));
       }
     })()`,
  );

  // The model picker at the foot of the window opens upward, stays inside
  // the window and scrolls, with only the session's own tool opened.
  await check(
    "the model picker stays inside the window, scrolls, and opens only the session's tool",
    `(async () => {
       const pill = document.querySelector('.composer .popover > .pill');
       if (!pill) return 'no model pill';
       pill.click();
       await new Promise(resolve => setTimeout(resolve, 400));
       const panel = document.querySelector('.popover__panel.picker');
       if (!panel) return 'no picker';
       const box = panel.getBoundingClientRect();
       const inside = box.top >= 0 && box.bottom <= innerHeight && box.left >= 0 && box.right <= innerWidth;
       const scrolls = getComputedStyle(panel).overflowY === 'auto';
       const open = panel.querySelectorAll('.picker__provider[data-open="true"]').length;
       const above = panel.dataset.placement === 'above';
       document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
       return (inside && scrolls && open <= 1 && above)
         || JSON.stringify({ box: [box.top, box.bottom, box.left, box.right, innerWidth, innerHeight], scrolls, open, above });
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
      await capture(
        "teams-edit",
        `${sidebar("Teams")}
         await new Promise(resolve => setTimeout(resolve, 300));
         [...document.querySelectorAll('.provider-entry')]
           .find(node => node.textContent?.includes('Check team'))
           ?.querySelector('button[aria-expanded]')?.click();`,
      );
      // A team at work in a session: members, feed, where it writes.
      const teamSession = `[...document.querySelectorAll('.sidebar__scroll .row')]
           .find(node => node.textContent?.includes('Team space'))?.click();
         await new Promise(resolve => setTimeout(resolve, 300));
         [...document.querySelectorAll('button')]
           .find(node => node.textContent?.trim() === 'Chat')?.click();
         await new Promise(resolve => setTimeout(resolve, 900));`;
      await capture("team-session", teamSession);
      await capture(
        "team-session-member",
        `${teamSession}
         [...document.querySelectorAll('.team-members [role="tab"]')]
           .find(node => node.textContent?.includes('Builder'))?.click();
         await new Promise(resolve => setTimeout(resolve, 300));`,
      );
      await capture("settings", sidebar("Settings"));
      await capture("skills", sidebar("Skills"));
      await capture("usage", sidebar("Usage"));
      await capture("connectors", sidebar("Connectors"));
      await capture(
        "connectors-discover",
        `${sidebar("Connectors")}
         await new Promise(resolve => setTimeout(resolve, 200));
         [...document.querySelectorAll('.segmented__item')]
           .find(node => node.textContent === 'Discover')?.click();`,
      );
      await capture(
        "connectors-gmail",
        `[...document.querySelectorAll('.connector-card')]
           .find(node => node.textContent?.includes('Gmail'))?.click();`,
      );
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
                 // The title reads on the island's own card, whichever
                 // mode it is in: dark ink on a dark card once made it vanish.
                 titleReadable: (() => {
                   const title = document.querySelector('.isl__attitle');
                   const card = title?.closest('.isl__sheet, .isl__attn, .isl__card');
                   if (!title || !card) return false;
                   const parse = (value) => (value.match(/[\\d.]+/g) ?? []).map(Number);
                   const [r = 0, g = 0, b = 0] = parse(getComputedStyle(title).color);
                   const [br = 0, bg = 0, bb = 0, ba = 1] = parse(getComputedStyle(card).backgroundColor);
                   // Over the darkest desktop, the worst case for a translucent card.
                   const ground = [br * ba, bg * ba, bb * ba];
                   const lum = (c) => c.map(v => { const x = v / 255; return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; })
                     .reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i], 0);
                   const [hi, lo] = [lum([r, g, b]), lum(ground)].sort((x, y) => y - x);
                   return (hi + 0.05) / (lo + 0.05) >= 4.5;
                 })(),
               };
             })()`,
          );
          seen = JSON.stringify({ icon: entry.icon, options: entry.options, face });
          const shown = face as {
            face: string;
            mark: boolean;
            buttons: string[];
            title: string;
            titleReadable: boolean;
          };
          if (
            entry.icon === agent.providerId &&
            shown.face === "approval" &&
            shown.mark &&
            shown.buttons.includes("Allow") &&
            shown.buttons.includes("Deny") &&
            shown.title.includes(`wants to use ${agent.tool ?? "Bash"}`) &&
            shown.titleReadable
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

    // Its turn ended, and the island says so with the way back to its tile.
    await checkMain(`the island says ${agent.label} finished, and opens its tile`, async () => {
      const tileId = await window.webContents.executeJavaScript("window.__checkWaitingTile");
      const deadline = Date.now() + 6_000;
      let seen = "nothing";
      while (Date.now() < deadline) {
        const state = await island.refresh();
        const done = state.entries.find(
          (item) => item.widget === "completedWork" && item.title === `${agent.label} finished`,
        );
        seen = JSON.stringify(state.entries.map((item) => [item.widget, item.title]));
        const target = done?.action?.target;
        if (target && target.tileId === tileId) {
          island.open(target);
          const landed = await window.webContents.executeJavaScript(
            `(async () => {
               const deadline = Date.now() + 4000;
               while (Date.now() < deadline) {
                 const tile = document.querySelector('.agent-tile[data-tile-id=${JSON.stringify(String(tileId))}]');
                 if (tile?.dataset.focused === 'true') return true;
                 await new Promise(resolve => setTimeout(resolve, 100));
               }
               return false;
             })()`,
          );
          // Back to the conversation for the checks that follow.
          await window.webContents.executeJavaScript(
            `[...document.querySelectorAll('button')].find(node => node.textContent?.trim() === 'Chat')?.click()`,
          );
          if (landed === true) {
            return true;
          }
          throw new Error("the island opened the window, but not on the tile");
        }
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      throw new Error(`no finished entry for the tile; the island had ${seen}`);
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

    // A tool whose own reports never reach the application — Antigravity has
    // no hooks the application could use, and hooks may not run at all on a
    // machine — still shows its dialog on screen. The stand-in draws
    // Antigravity's own permission dialog and reads its own arrow keys; the
    // island reads the dialog from the tile's screen and answers it there.
    const agyFixture = join(dirname(workspaceDirectory), "fixture-antigravity");
    const agyStandIn = join(agyFixture, "agy");
    const agyAnswer = join(agyFixture, "answer.json");
    await mkdir(agyFixture, { recursive: true });
    await rm(agyAnswer, { force: true });
    await writeFile(agyStandIn, STAND_IN_ANTIGRAVITY, { mode: 0o755 });
    await check(
      "a tool without hooks shows its dialog as waiting, read from its screen",
      `(async () => {
         const api = window.workbench;
         const workspaceId = window.__checkWorkspaceId;
         await api.invoke('provider.saveConfig', {
           providerId: 'antigravity', enabled: true, executablePath: ${JSON.stringify(agyStandIn)},
         });
         const tile = await api.invoke('agentTerminal.launch', {
           workspaceId, providerId: 'antigravity', label: 'Antigravity',
         });
         window.__checkScreenTile = tile.id;
         const deadline = Date.now() + 15000;
         while (Date.now() < deadline) {
           const current = (await api.invoke('agentTerminal.list', { workspaceId }))
             .find(entry => entry.id === tile.id);
           const waiting = current?.attention;
           if (waiting) {
             return waiting.kind === 'question' && waiting.answerable
               && waiting.summary === 'Run this command?'
               && waiting.context === 'node -c real-estate/server.js; node -c real-estate/app.js'
               && waiting.choices.map(choice => choice.label).join('|')
                 === "Yes, run command|Yes, and always allow in this conversation|No, cancel"
               || JSON.stringify(waiting);
           }
           await new Promise(resolve => setTimeout(resolve, 200));
         }
         return 'the tile never showed that it waits';
       })()`,
      30_000,
    );

    await checkMain("the island shows that dialog with the tool's own options, and picks one there", async () => {
      window.blur();
      const deadline = Date.now() + 12_000;
      let seen = "nothing";
      while (Date.now() < deadline) {
        const state = await island.refresh();
        const entry = state.entries.find((item) => item.widget === "agentQuestion" && item.icon === "antigravity");
        const target = islandWindow();
        if (entry && target?.isVisible()) {
          const shown = (await islandJs(
            `(async () => {
               const unit = document.querySelector('.isl');
               if (unit?.dataset.face === 'question' && !document.querySelector('.isl__option')) {
                 document.querySelector('.isl__circle, .isl__pill')?.click();
                 await new Promise(resolve => setTimeout(resolve, 600));
               }
               const options = [...document.querySelectorAll('.isl__option .isl__optionlabel')]
                 .map(node => node.textContent?.trim());
               return {
                 face: unit?.dataset.face ?? null,
                 options,
                 title: document.querySelector('.isl__qtitle')?.textContent ?? '',
               };
             })()`,
          )) as { face: string | null; options: string[]; title: string };
          seen = JSON.stringify({ shown, options: entry.options, title: entry.title, detail: entry.detail });
          const offered =
            entry.title === "Run this command?" &&
            entry.detail.startsWith("node -c real-estate/server.js") &&
            entry.options.map((option) => option.label).join("|") ===
              "Yes, run command|Yes, and always allow in this conversation|No, cancel";
          // An approval left over from the checks above comes first on the
          // island; the question waits behind it and is answered the same way
          // its buttons answer it.
          const inView =
            shown.face !== "question" ||
            (shown.options.length === 3 && shown.title === "Run this command?");
          if (offered && inView) {
            // The second option: the island moves the tool's marker down one
            // with its own arrow key, sees it there, then presses Enter.
            if (shown.face === "question") {
              await islandJs(
                `[...document.querySelectorAll('.isl__option')]
                   .find(node => node.textContent?.includes('always allow in this conversation'))?.click()`,
              );
            } else {
              const second = entry.options[1]?.id ?? "";
              const { answered } = await island.respond(entry.key, second);
              if (!answered) {
                throw new Error("the island's answer was not taken");
              }
            }
            const until = Date.now() + 10_000;
            while (Date.now() < until) {
              const printed = await readFile(agyAnswer, "utf8").catch(() => null);
              if (printed !== null) {
                const chosen = (JSON.parse(printed) as { chose?: number }).chose;
                if (chosen === 2) {
                  return true;
                }
                throw new Error(`the tool took option ${String(chosen)}`);
              }
              await new Promise((resolve) => setTimeout(resolve, 150));
            }
            throw new Error("the tool never took an answer");
          }
        }
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      throw new Error(`the island showed ${seen}`);
    });

    await checkMain("the island lets go of the dialog once the tool took the answer", async () => {
      const deadline = Date.now() + 8_000;
      while (Date.now() < deadline) {
        const state = await island.refresh();
        if (!state.entries.some((item) => item.widget === "agentQuestion")) {
          return true;
        }
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
      throw new Error("the question stayed on the island");
    });

    // A tool that reports no usage is listed and says so, rather than left out.
    await check(
      "a tool that reports no usage is listed as not reporting it",
      `(async () => {
         [...document.querySelectorAll('.sidebar__foot .row')].find(row => row.textContent?.includes('Usage'))?.click();
         const listed = await ${waitFor("[...document.querySelectorAll('.usage-card[data-reports=\"false\"]')].some(card => card.textContent?.includes('Antigravity') && card.textContent?.includes('Not reported by this tool'))", 5000)};
         return listed || 'cards: ' + [...document.querySelectorAll('.usage-card')].map(card => card.getAttribute('aria-label') + '/' + card.dataset.reports).join(', ')
           + ' | antigravity: ' + JSON.stringify((await window.workbench.invoke('provider.list', undefined)).filter(entry => entry.metadata.id.startsWith('antigravity')).map(entry => [entry.metadata.id, entry.enabled, entry.installation.state]));
       })()`,
    );

    await check(
      "the stand-in for Antigravity is removed again",
      `(async () => {
         const api = window.workbench;
         const removed = await api.invoke('agentTerminal.remove', { id: window.__checkScreenTile });
         await api.invoke('provider.saveConfig', { providerId: 'antigravity', executablePath: null });
         return removed.removed;
       })()`,
    );
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
  const checkKeyFile = join(dirname(workspaceDirectory), "id_check");
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
    const { startSshTestServer, generateEd25519KeyPair } = await import("@ai-workbench/test-support");
    // A passphrase-protected key, the way most people's keys are, as a file
    // on this computer; the machine knows its public half.
    const key = generateEd25519KeyPair({
      passphrase: CHECK_KEY_PASSPHRASE,
      cipher: "aes256-ctr",
      rounds: 16,
    });
    await writeFile(checkKeyFile, key.private, { mode: 0o600 });
    sshServer = await startSshTestServer({
      directory: remoteDirectory,
      authorizedKeys: [key.public],
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
      "a key file with a passphrase signs in, and a missing passphrase is named",
      `(async () => {
         const api = window.workbench;
         const input = {
           name: 'Check key machine',
           host: ${JSON.stringify(server.host)},
           port: ${server.port},
           username: ${JSON.stringify(server.username)},
           auth: 'key',
           keyFile: ${JSON.stringify(checkKeyFile)},
         };
         const refused = await api.invoke('connection.create', input).then(
           () => 'created without its passphrase',
           error => String(error.message ?? error),
         );
         if (!/protected by a passphrase/.test(refused)) return 'without passphrase: ' + refused;
         const connection = await api.invoke('connection.create', {
           ...input,
           passphrase: ${JSON.stringify(CHECK_KEY_PASSPHRASE)},
         });
         const result = await api.invoke('connection.test', { id: connection.id });
         await api.invoke('connection.delete', { id: connection.id });
         return result.ok ? true : 'test failed: ' + result.error;
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
/**
 * Antigravity's permission dialog, as it showed on a Windows machine, drawn
 * by a stand-in that reads its own arrow keys and Enter — no hooks at all.
 */
const STAND_IN_ANTIGRAVITY = `#!/usr/bin/env node
const { writeFileSync } = require("node:fs");
const { join } = require("node:path");
const args = process.argv.slice(2);
if (args.includes("--version")) {
  process.stdout.write("agy 1.0.0\\n");
  process.exit(0);
}
if (args[0] === "models") {
  process.stdout.write("gemini-3.8-flash\\tGemini 3.8 Flash\\n");
  process.exit(0);
}
const options = ["Yes, run command", "Yes, and always allow in this conversation", "No, cancel"];
let selected = 0;
let answered = false;
const out = (text) => process.stdout.write(text.replace(/\\n/g, "\\r\\n"));
function draw(first) {
  if (!first) out("\\x1b[" + (options.length + 3) + "A");
  out("\\r\\x1b[2KRun this command?\\n");
  options.forEach((option, index) => out("\\r\\x1b[2K" + (index === selected ? "> " : "  ") + (index + 1) + ". " + option + "\\n"));
  out("\\r\\x1b[2K\\n\\r\\x1b[2K  \\u2191/\\u2193 Navigate \\u00b7 tab Amend\\n");
}
out("\\u25cf Bash(node -c real-estate/server.js; node -c real-estate/app.js)\\n\\nCommand\\n" + "\\u2500".repeat(40) + "\\n\\n");
out("Requesting permission for:\\n   node -c real-estate/server.js; node -c real-estate/app.js\\n\\n");
draw(true);
process.stdin.setRawMode?.(true);
process.stdin.setEncoding("utf8");
process.stdin.resume();
process.stdin.on("data", (key) => {
  if (answered) return;
  if (key === "\\r") {
    answered = true;
    writeFileSync(join(__dirname, "answer.json"), JSON.stringify({ chose: selected + 1 }));
    out("\\x1b[" + (options.length + 3) + "A\\x1b[J\\u25cf Ran the command.\\n\\n> ");
    return;
  }
  if (key === "\\x1b[A" || key === "\\x1bOA") selected = Math.max(0, selected - 1);
  if (key === "\\x1b[B" || key === "\\x1bOB") selected = Math.min(options.length - 1, selected + 1);
  draw(false);
});
`;

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

/**
 * The check's browser for sign-in pages: the stand-in service approves at
 * once and redirects, and this follows the redirect to the app's listener,
 * as a person's browser would after they clicked Allow.
 */
export async function approveSignInPage(url: string): Promise<void> {
  const page = await fetch(url, { redirect: "manual" });
  const location = page.headers.get("location");
  if (location) {
    await fetch(location);
  }
}
