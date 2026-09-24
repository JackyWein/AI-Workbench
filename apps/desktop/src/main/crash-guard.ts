import { mkdir, readFile, readdir, rm, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { app, BrowserWindow, dialog, type WebContents } from "electron";
import type { Logger } from "@ai-workbench/shared";

/** What the previous run of the application left behind. */
export interface PreviousExit {
  /** The previous run ended without shutting down: a crash, a kill, a forced restart. */
  readonly unclean: boolean;
  /** When that run started, if it said. */
  readonly startedAt: Date | null;
  /** Where its crash report was written, if one was. */
  readonly reportPath: string | null;
}

/** An error the renderer caught and handed to the main process to keep. */
export interface RendererErrorReport {
  readonly source: string;
  readonly message: string;
  readonly stack?: string | undefined;
  readonly componentStack?: string | undefined;
}

interface SessionMarker {
  readonly pid: number;
  readonly startedAt: string;
  readonly version: string;
}

const MARKER_FILE = "session.json";
const REPORTS_DIRECTORY = "crash-reports";
/** Reports kept on disk; the oldest go first. */
const MAX_REPORTS = 20;
/** A crashing window is reloaded at most this often before the person decides. */
const MAX_RELOADS = 3;
const RELOAD_WINDOW_MS = 60_000;
/** A window that stays unresponsive this long is offered a reload. */
const UNRESPONSIVE_GRACE_MS = 15_000;
/** Crash reports written from a burst of errors are spaced out. */
const REPORT_INTERVAL_MS = 10_000;

/**
 * Keeps the application standing when something inside it fails, and makes
 * sure every failure leaves a trace (spec §60, §132).
 *
 * - An exception or a rejected promise nobody handled is logged with its
 *   stack and written to a crash report; the application keeps running
 *   rather than dying or showing Electron's raw error dialog.
 * - A window whose renderer crashed is reloaded — the runtime lives in the
 *   main process, so nothing is lost — and after repeated crashes the person
 *   chooses between reloading and quitting instead of a reload loop.
 * - A window that stops responding is offered a reload after a grace period.
 * - A marker file tells the next start whether this one ended cleanly, so an
 *   unexpected stop is reported and what it left half-done is recovered.
 */
export class CrashGuard {
  #logger: Logger | null = null;
  #userDataPath: string | null = null;
  #version = "unknown";
  #interactive = true;
  #previous: PreviousExit = { unclean: false, startedAt: null, reportPath: null };
  #lastReportAt = 0;
  #handlersInstalled = false;
  readonly #reloads = new Map<number, number[]>();
  readonly #unresponsiveTimers = new Map<number, NodeJS.Timeout>();
  readonly #askingAbout = new Set<number>();

  /**
   * Catches what nobody handled from the first line of the process on. Before
   * the log exists, failures go to stderr; they are never swallowed.
   */
  installProcessHandlers(): void {
    if (this.#handlersInstalled) {
      return;
    }
    this.#handlersInstalled = true;
    process.on("uncaughtException", (error) => {
      this.#record("uncaughtException", error);
    });
    process.on("unhandledRejection", (reason) => {
      this.#record("unhandledRejection", reason);
    });
    app.on("render-process-gone", (_event, contents, details) => {
      this.#rendererGone(contents, details.reason, details.exitCode);
    });
    app.on("child-process-gone", (_event, details) => {
      if (details.reason === "clean-exit") {
        return;
      }
      // The GPU or a utility process: Electron restarts it itself; the trace
      // is what matters when it keeps happening.
      this.#log("warn", "A helper process ended unexpectedly", {
        type: details.type,
        reason: details.reason,
        exitCode: details.exitCode,
        ...(details.name ? { name: details.name } : {}),
      });
    });
  }

  /**
   * Reads what the previous run left behind and marks this one as running.
   * Must be called once the user-data directory is final.
   */
  async begin(options: {
    readonly userDataPath: string;
    readonly version: string;
    /** False for headless checks: nobody is there to answer a dialog. */
    readonly interactive: boolean;
  }): Promise<PreviousExit> {
    this.#userDataPath = options.userDataPath;
    this.#version = options.version;
    this.#interactive = options.interactive;

    const markerPath = join(options.userDataPath, MARKER_FILE);
    let previous: SessionMarker | null = null;
    try {
      previous = JSON.parse(await readFile(markerPath, "utf8")) as SessionMarker;
    } catch {
      previous = null;
    }

    if (previous && previous.pid !== process.pid) {
      // The last run never removed its marker: it did not shut down.
      const reportPath = await this.#writeReport({
        kind: "uncleanExit",
        message: "The previous run of AI Workbench ended without shutting down.",
        previousRun: previous,
        logTail: await this.#logTail(),
      }).catch(() => null);
      this.#previous = {
        unclean: true,
        startedAt: Number.isNaN(Date.parse(previous.startedAt)) ? null : new Date(previous.startedAt),
        reportPath,
      };
    }

    const marker: SessionMarker = {
      pid: process.pid,
      startedAt: new Date().toISOString(),
      version: options.version,
    };
    await mkdir(options.userDataPath, { recursive: true });
    await writeFile(markerPath, JSON.stringify(marker), "utf8");
    return this.#previous;
  }

  /** The log is created after the guard; failures are sent there from now on. */
  attachLogger(logger: Logger): void {
    this.#logger = logger.child("CORE");
    if (this.#previous.unclean) {
      this.#logger.warn("The previous run did not shut down cleanly", {
        startedAt: this.#previous.startedAt?.toISOString() ?? null,
        report: this.#previous.reportPath,
      });
    }
  }

  get previousExit(): PreviousExit {
    return this.#previous;
  }

  get reportsDirectory(): string | null {
    return this.#userDataPath ? join(this.#userDataPath, REPORTS_DIRECTORY) : null;
  }

  /** A clean shutdown removes the marker, so the next start knows. */
  async markCleanExit(): Promise<void> {
    if (!this.#userDataPath) {
      return;
    }
    await unlink(join(this.#userDataPath, MARKER_FILE)).catch(() => undefined);
  }

  /** Watches one window for hangs. The app-wide handlers cover crashes. */
  watchWindow(window: BrowserWindow): void {
    const id = window.webContents.id;
    window.on("unresponsive", () => {
      this.#log("warn", "A window stopped responding", { windowId: id });
      if (this.#unresponsiveTimers.has(id)) {
        return;
      }
      const timer = setTimeout(() => {
        this.#unresponsiveTimers.delete(id);
        void this.#offerReload(window, "AI Workbench is not responding", [
          "The window has not responded for a while. Work that runs in the " +
            "background — sessions, teams, terminals — is not affected.",
        ]);
      }, UNRESPONSIVE_GRACE_MS);
      timer.unref();
      this.#unresponsiveTimers.set(id, timer);
    });
    window.on("responsive", () => {
      const timer = this.#unresponsiveTimers.get(id);
      if (timer) {
        clearTimeout(timer);
        this.#unresponsiveTimers.delete(id);
        this.#log("info", "The window responds again", { windowId: id });
      }
    });
    window.on("closed", () => {
      const timer = this.#unresponsiveTimers.get(id);
      if (timer) {
        clearTimeout(timer);
      }
      this.#unresponsiveTimers.delete(id);
      this.#reloads.delete(id);
    });
    window.webContents.on("preload-error", (_event, path, error) => {
      this.#record("preloadError", error, { path });
    });
  }

  /** Keeps an error the renderer caught, in the log and in a report. */
  recordRendererError(report: RendererErrorReport): void {
    this.#log("error", "The interface reported an error", {
      source: report.source,
      error: report.message,
      ...(report.stack ? { stack: truncate(report.stack, 4000) } : {}),
      ...(report.componentStack ? { componentStack: truncate(report.componentStack, 2000) } : {}),
    });
    void this.#throttledReport({
      kind: "rendererError",
      source: report.source,
      message: report.message,
      stack: report.stack ?? null,
      componentStack: report.componentStack ?? null,
    });
  }

  #record(kind: string, error: unknown, extra: Record<string, unknown> = {}): void {
    const message = error instanceof Error ? error.message : String(error);
    const stack = error instanceof Error ? error.stack : undefined;
    this.#log("error", "Unhandled failure in the main process", {
      kind,
      error: message,
      ...(stack ? { stack: truncate(stack, 4000) } : {}),
      ...extra,
    });
    void this.#throttledReport({ kind, message, stack: stack ?? null, ...extra });
  }

  #rendererGone(contents: WebContents, reason: string, exitCode: number): void {
    if (reason === "clean-exit") {
      return;
    }
    const window = BrowserWindow.fromWebContents(contents);
    this.#log("error", "A window's renderer process ended", {
      reason,
      exitCode,
      windowId: contents.id,
    });
    void this.#throttledReport({ kind: "renderProcessGone", reason, exitCode });
    if (!window || window.isDestroyed()) {
      return;
    }

    const now = Date.now();
    const recent = (this.#reloads.get(contents.id) ?? []).filter(
      (at) => now - at < RELOAD_WINDOW_MS,
    );
    if (recent.length >= MAX_RELOADS) {
      void this.#offerReload(window, "The window keeps crashing", [
        `It crashed ${recent.length + 1} times within a minute (${reason}). ` +
          "Background work — sessions, teams, terminals — keeps running.",
      ]);
      return;
    }
    recent.push(now);
    this.#reloads.set(contents.id, recent);
    // Everything the window shows lives in the main process: a reload brings
    // the same sessions, runs and terminals back.
    setTimeout(() => {
      if (!window.isDestroyed()) {
        window.webContents.reload();
      }
    }, 500).unref();
  }

  async #offerReload(window: BrowserWindow, title: string, detail: string[]): Promise<void> {
    if (window.isDestroyed() || this.#askingAbout.has(window.id)) {
      return;
    }
    if (!this.#interactive) {
      return;
    }
    this.#askingAbout.add(window.id);
    try {
      const { response } = await dialog.showMessageBox(window, {
        type: "warning",
        title,
        message: title,
        detail: detail.join("\n\n"),
        buttons: ["Reload window", "Wait", "Quit AI Workbench"],
        defaultId: 0,
        cancelId: 1,
        noLink: true,
      });
      if (window.isDestroyed()) {
        return;
      }
      if (response === 0) {
        this.#reloads.delete(window.webContents.id);
        window.webContents.reload();
      } else if (response === 2) {
        app.quit();
      }
    } finally {
      this.#askingAbout.delete(window.id);
    }
  }

  async #throttledReport(content: Record<string, unknown>): Promise<void> {
    const now = Date.now();
    if (now - this.#lastReportAt < REPORT_INTERVAL_MS) {
      return;
    }
    this.#lastReportAt = now;
    await this.#writeReport({ ...content, logTail: await this.#logTail() }).catch(() => null);
  }

  /** Writes one report file and keeps only the newest few. */
  async #writeReport(content: Record<string, unknown>): Promise<string | null> {
    const directory = this.reportsDirectory;
    if (!directory) {
      return null;
    }
    await mkdir(directory, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const path = join(directory, `crash-${stamp}.json`);
    const report = {
      at: new Date().toISOString(),
      version: this.#version,
      platform: process.platform,
      arch: process.arch,
      electron: process.versions["electron"] ?? null,
      pid: process.pid,
      ...content,
    };
    await writeFile(path, JSON.stringify(report, null, 2), "utf8");

    const files = (await readdir(directory))
      .filter((name) => name.startsWith("crash-") && name.endsWith(".json"))
      .sort();
    for (const name of files.slice(0, Math.max(0, files.length - MAX_REPORTS))) {
      await rm(join(directory, name), { force: true }).catch(() => undefined);
    }
    return path;
  }

  /**
   * The last lines of the application log, which is where the cause of a
   * crash usually shows. The logger redacts secrets before writing, so the
   * tail carries none.
   */
  async #logTail(lines = 120): Promise<string[]> {
    if (!this.#userDataPath) {
      return [];
    }
    try {
      const text = await readFile(join(this.#userDataPath, "ai-workbench.log"), "utf8");
      return text.split(/\r?\n/).filter(Boolean).slice(-lines);
    } catch {
      return [];
    }
  }

  #log(level: "info" | "warn" | "error", message: string, fields: Record<string, unknown>): void {
    try {
      if (this.#logger) {
        this.#logger[level](message, fields);
        return;
      }
    } catch {
      // A broken logger must not turn one failure into a loop of them.
    }
    console.error(`[${level}] ${message}`, fields);
  }
}

function truncate(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, limit)}…`;
}
