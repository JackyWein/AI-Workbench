import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { BrowserWindow, screen } from "electron";
import { execCli } from "@ai-workbench/transport-cli";
import type { Logger } from "@ai-workbench/shared";
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
 * Headless verification of a real application start, used by `pnpm verify:app`
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
           const node = document.querySelector('.island');
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

  /** Waits until the island page renders the current widget's title. */
  const waitIslandDom = async (timeoutMs = 10_000): Promise<boolean> => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        const ready = await islandJs(
          "Boolean(document.querySelector('.island__title')?.textContent)",
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
    "Boolean(document.querySelector('.app') && document.querySelector('.sidebar'))",
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
       const state = await window.workbench.invoke('statusIsland.setPreferences', {
         enabled: true,
         autoExpand: true,
       });
       if (!state.preferences.enabled) return false;
       return state.entries.some(entry => entry.widget === 'providerUsage')
         && state.entries.every((entry, index, all) =>
           index === 0 || all[index - 1].priority >= entry.priority);
     })()`,
  );

  await checkMain("the island is a separate visible window", async () => {
    if (!island.visible) {
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
    // Compact, with the usage title the service reported — nothing invented.
    const bounds = target.getBounds();
    const title = await islandJs(
      "document.querySelector('.island__title')?.textContent ?? ''",
    );
    return (
      bounds.width === 320 &&
      bounds.height === 44 &&
      typeof title === "string" &&
      /mock \d+%/.test(title)
    );
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
      if (!island.visible) {
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
         const state = await window.workbench.invoke('statusIsland.getState', undefined);
         return state.entries.some(item => item.widget === 'completedWork')
           && state.entries.some(item => item.widget === 'needsAttention')
           && state.entries.every((entry, index, all) =>
             index === 0 || all[index - 1].priority >= entry.priority);
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
    "usage detail opens on keyboard focus",
    `(() => {
       const trigger = document.querySelector('.usage-indicator');
       if (!trigger) return false;
       trigger.blur();
       trigger.focus();
       return ${waitFor("document.querySelector('.popover__panel')", 2000)};
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

  await check(
    "a long screen scrolls and leaves the navigation reachable",
    `(async () => {
       [...document.querySelectorAll('.sidebar__foot .row')]
         .find(row => row.textContent?.includes('Providers'))?.click();
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
           [...document.querySelectorAll('.panel__tab')]
             .find(node => node.textContent === 'Changes')?.click();
           await new Promise(resolve => setTimeout(resolve, 600));
           const branch = document.querySelector('.changes__branch')?.textContent ?? '';
           const items = [...document.querySelectorAll('.changes__item')]
             .map(node => node.textContent ?? '');
           return branch.includes('main') && items.some(text => text.includes('untracked.txt'));
         })()`
      : `(async () => {
           [...document.querySelectorAll('.panel__tab')]
             .find(node => node.textContent === 'Changes')?.click();
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
       window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true }));
       await new Promise(resolve => setTimeout(resolve, 120));
       const item = [...document.querySelectorAll('.palette__item')]
         .find(node => node.textContent?.includes('Cycle Status Island widget'));
       if (!item) return false;
       item.click();
       await new Promise(resolve => setTimeout(resolve, 400));
       if (document.querySelector('.palette') !== null) return false;
       const state = await window.workbench.invoke('statusIsland.getState', undefined);
       return state.current.widget === 'connectionHealth'
         && state.preferences.pinnedWidget === 'connectionHealth';
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
       return state.current.widget === 'connectionHealth'
         && state.preferences.pinnedWidget === 'connectionHealth';
     })()`,
  );

  await check(
    "cycling and pinning follow the widget order",
    `(async () => {
       const api = window.workbench;
       const first = await api.invoke('statusIsland.cycle', { direction: 1 });
       if (first.current.widget !== 'connectionHealth') return false;
       const back = await api.invoke('statusIsland.cycle', { direction: -1 });
       if (back.current.widget !== 'needsAttention') return false;

       const pinned = await api.invoke('statusIsland.pinWidget', { widget: 'providerUsage' });
       if (pinned.current.widget !== 'providerUsage') return false;
       if (!/mock \\d+%/.test(pinned.current.title ?? '')) return false;

       // A pinned widget with nothing to say stays honest (spec §103).
       const idle = await api.invoke('statusIsland.pinWidget', { widget: 'teamProgress' });
       if (idle.current.title !== 'Team progress · nothing to report') return false;

       // Automatic mode is the priority order, highest first.
       const automatic = await api.invoke('statusIsland.pinWidget', { widget: null });
       return automatic.preferences.pinnedWidget === null
         && automatic.current.widget === 'needsAttention'
         && automatic.entries.every((entry, index, all) =>
           index === 0 || all[index - 1].priority >= entry.priority);
     })()`,
  );

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
       const resume = existing
         ? (await api.invoke('team.listRuns', { teamId: team.id }))
           .find(run => run.status === 'completed')
         : null;
       const run = resume ?? await api.invoke('team.startRun', {
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

  await checkMain("the expanded island offers to open the run", async () => {
    const target = islandWindow();
    if (!target) {
      return false;
    }
    const bounds = target.getBounds();
    const actions = await islandJs(
      "[...document.querySelectorAll('.island__actions button')].map(node => node.textContent)",
    );
    return (
      bounds.width === 380 &&
      bounds.height === 132 &&
      Array.isArray(actions) &&
      actions.some((label) => typeof label === "string" && label.includes("Open"))
    );
  });

  // The deep link the island offers, clicked where a user clicks it: the main
  // window lands on the run the entry is about, and the island settles back.
  await checkMain("the island opens the run it is about", async () => {
    try {
      const clicked = await islandJs(
        `(() => {
           const button = [...document.querySelectorAll('.island__actions button')]
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
    const bounds = target.getBounds();
    const actions = await islandJs(
      "document.querySelectorAll('.island__actions').length",
    );
    const state = await island.refresh();
    return (
      bounds.width === 320 &&
      bounds.height === 44 &&
      actions === 0 &&
      state.expanded === false
    );
  });

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
      await window.webContents.executeJavaScript(
        `(async () => {
         const rows = [...document.querySelectorAll('.sidebar__scroll .row')];
         rows.find(node => node.textContent?.includes('Check workspace'))?.click();
         await new Promise(resolve => setTimeout(resolve, 300));
         // Show the workspace tools, since that is what changed most recently.
         [...document.querySelectorAll('.panel__tab')]
           .find(node => node.textContent === 'Terminal')?.click();
         return true;
       })()`,
      );
      await new Promise((resolve) => setTimeout(resolve, 600));
      await writeFile(screenshotPath, (await window.webContents.capturePage()).toPNG());

      // The providers screen is captured too, since it is where a user fixes a
      // command line provider that does not work.
      const providersPath = screenshotPath.replace(/\.png$/, "-providers.png");
      await window.webContents.executeJavaScript(
        `(() => {
         const rows = [...document.querySelectorAll('.sidebar__foot .row')];
         rows.find(node => node.textContent?.includes('Providers'))?.click();
         return true;
       })()`,
      );
      await new Promise((resolve) => setTimeout(resolve, 400));
      await writeFile(providersPath, (await window.webContents.capturePage()).toPNG());

      logger.info("Startup check screenshots written", {
        chat: screenshotPath,
        providers: providersPath,
      });
    } catch (error) {
      logger.warn("Startup check screenshots failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
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
      return false;
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
