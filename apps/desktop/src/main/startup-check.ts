import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { BrowserWindow } from "electron";
import { execCli } from "@ai-workbench/transport-cli";
import type { Logger } from "@ai-workbench/shared";

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
  options: { workspaceDirectory: string; mode: StartupCheckMode },
): Promise<StartupCheckResult> {
  const { workspaceDirectory, mode } = options;
  const repository = await seedWorkspace(workspaceDirectory);
  const rendererErrors: string[] = [];
  window.webContents.on("console-message", (event) => {
    if (event.level === "error") {
      rendererErrors.push(event.message);
    }
  });

  await once(window, "did-finish-load");

  const outcomes: CheckOutcome[] = [];
  const check = async (name: string, script: string): Promise<boolean> => {
    try {
      const value: unknown = await window.webContents.executeJavaScript(script);
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
    }
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

  await check(
    "usage detail opens on keyboard focus",
    `(() => {
       const trigger = document.querySelector('.usage-indicator');
       trigger?.focus();
       return new Promise(resolve => setTimeout(
         () => resolve(Boolean(document.querySelector('.popover__panel'))), 60));
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

  // An optional screenshot makes the rendered result reviewable by a human
  // instead of only asserted by selectors.
  const screenshotPath = process.env["AI_WORKBENCH_CHECK_SCREENSHOT"];
  if (screenshotPath) {
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
    await run("config", "user.email", "check@example.com");
    await run("config", "user.name", "Startup check");
    await run("add", "notes.md");
    await run("commit", "-m", "initial");
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

    // Later checks address this session directly.
    window.__checkSessionId = session.id;

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

function once(window: BrowserWindow, event: "did-finish-load"): Promise<void> {
  return new Promise((resolve) => {
    if (!window.webContents.isLoading()) {
      resolve();
      return;
    }
    window.webContents.once(event, () => resolve());
  });
}
