import { readFileSync } from "node:fs";
import { join } from "node:path";
import { app, net, shell } from "electron";
import type { AppEvent, Logger, UpdateState } from "@ai-workbench/shared";

export interface UpdaterDeps {
  readonly logger: Logger;
  readonly publish: (event: AppEvent) => void;
  readonly currentVersion: string;
}

/**
 * The slice of electron-updater this file uses. It is declared locally on
 * purpose: the package is loaded with a dynamic import at runtime, so
 * typecheck and development runs keep working before `bun install` has
 * provided it, and the bundler always keeps it external. After install the
 * real module satisfies this shape.
 */
interface AutoUpdaterLike {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  checkForUpdates(): Promise<unknown>;
  downloadUpdate(): Promise<unknown>;
  quitAndInstall(): void;
  on(event: string, listener: (...args: Array<unknown>) => void): unknown;
}

let deps: UpdaterDeps | null = null;
let setupPromise: Promise<AutoUpdaterLike | null> | null = null;
let state: UpdateState = {
  status: "idle",
  currentVersion: "",
  availableVersion: null,
  releaseNotes: null,
  error: null,
  progress: null,
  installsItself: true,
  manualReason: null,
  releaseUrl: null,
};

/**
 * Whether this build can replace itself. electron-updater installs over the
 * Windows setup version and the AppImage. It cannot touch the portable
 * Windows file, macOS installs only updates signed like the running app (this
 * build is not signed), and a Linux archive has nothing to install into — so
 * for those a new version is fetched from its release page instead.
 */
export function selfInstall(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
): { installsItself: boolean; reason: string | null } {
  if (platform === "win32" && env["PORTABLE_EXECUTABLE_FILE"]) {
    return {
      installsItself: false,
      reason:
        "The portable version can't replace itself. Download the new one, or install the setup version once to update in place from then on.",
    };
  }
  if (platform === "darwin") {
    return {
      installsItself: false,
      reason:
        "macOS only installs updates signed by a developer account, which this build isn't. Download the new version and move it to Applications.",
    };
  }
  if (platform === "linux" && !env["APPIMAGE"]) {
    return {
      installsItself: false,
      reason: "Only the AppImage updates itself. Download the new version from its release page.",
    };
  }
  return { installsItself: true, reason: null };
}

/** Where releases are published, as the packaged build records it. */
function releaseSource(): { owner: string; repo: string } | null {
  try {
    const text = readFileSync(join(process.resourcesPath, "app-update.yml"), "utf8");
    const owner = /^owner:\s*(\S+)/m.exec(text)?.[1];
    const repo = /^repo:\s*(\S+)/m.exec(text)?.[1];
    return owner && repo ? { owner, repo } : null;
  } catch {
    return null;
  }
}

function releasePage(version: string): string | null {
  const source = releaseSource();
  return source
    ? `https://github.com/${source.owner}/${source.repo}/releases/tag/v${version}`
    : null;
}

/**
 * Remembers the main-process dependencies. Warming up the loader here keeps
 * the first explicit check fast; a failure stays silent and surfaces on the
 * next explicit check instead. Never throws.
 */
export function initUpdater(next: UpdaterDeps): void {
  deps = next;
  const mode = selfInstall(process.platform, process.env);
  state = {
    status: "idle",
    currentVersion: next.currentVersion,
    availableVersion: null,
    releaseNotes: null,
    error: null,
    progress: null,
    installsItself: mode.installsItself,
    manualReason: mode.reason,
    releaseUrl: null,
  };
  setupPromise = null;
  if (app.isPackaged) {
    void ensureSetup();
  }
}

export function getUpdateState(): UpdateState {
  return { ...state };
}

/**
 * Asks GitHub Releases which version is current. Packaged apps only, and only
 * ever a check: with `autoDownload` off nothing is fetched until the user
 * asks for the download. Resolves `{ started: false }` — never rejects — when
 * there is no network, no updater module, or no packaged build.
 */
export async function checkForUpdates(): Promise<{ started: boolean }> {
  const current = deps;
  if (!current) {
    return { started: false };
  }
  if (!app.isPackaged) {
    current.logger.debug("Skipping update check: app is not packaged");
    setState({ status: "error", error: "Updates are only available in the installed app, not in development." });
    publish({ type: "update.error", message: "Updates are only available in the installed app, not in development." });
    return { started: false };
  }
  if (!state.installsItself) {
    return checkReleasePage(current);
  }
  const updater = await ensureSetup();
  if (!updater) {
    const message = "The updater module could not be loaded. Reinstall the app from GitHub Releases.";
    current.logger.warn("Update check skipped: no updater", {});
    setState({ status: "error", error: message });
    publish({ type: "update.error", message });
    return { started: false };
  }
  try {
    setState({ status: "checking", error: null, progress: null });
    publish({ type: "update.checking" });
    const result = await updater.checkForUpdates();
    if (result === null || result === undefined) {
      // electron-updater answers nothing, and emits nothing, for a build it
      // cannot update; "checking" must not stay on screen forever.
      const message = "This build can't check for updates. Download new versions from GitHub Releases.";
      setState({ status: "error", error: message });
      publish({ type: "update.error", message });
      return { started: false };
    }
    return { started: true };
  } catch (error) {
    const message = describeError(error);
    current.logger.warn("Update check failed", { error: message });
    setState({ status: "error", error: message });
    publish({ type: "update.error", message });
    return { started: false };
  }
}

/**
 * The check for a build that cannot update itself: the latest release, read
 * from GitHub's public API, compared with this version. Nothing is fetched
 * but that one answer; the download is the person's, from the release page.
 */
async function checkReleasePage(current: UpdaterDeps): Promise<{ started: boolean }> {
  const source = releaseSource();
  if (!source) {
    const message = "This build doesn't say where its releases are published.";
    setState({ status: "error", error: message });
    publish({ type: "update.error", message });
    return { started: false };
  }
  setState({ status: "checking", error: null, progress: null });
  publish({ type: "update.checking" });
  try {
    const response = await net.fetch(
      `https://api.github.com/repos/${source.owner}/${source.repo}/releases/latest`,
      { headers: { accept: "application/vnd.github+json" } },
    );
    if (!response.ok) {
      throw new Error(`GitHub answered ${response.status}`);
    }
    const release = (await response.json()) as {
      tag_name?: unknown;
      body?: unknown;
      html_url?: unknown;
    };
    const version = typeof release.tag_name === "string" ? release.tag_name.replace(/^v/, "") : "";
    if (!version || !isNewerVersion(version, state.currentVersion)) {
      setState({ status: "not-available", availableVersion: null, releaseNotes: null, releaseUrl: null });
      publish({ type: "update.not-available", version: state.currentVersion });
      return { started: true };
    }
    const releaseNotes = normalizeReleaseNotes(release.body);
    setState({
      status: "available",
      availableVersion: version,
      releaseNotes,
      releaseUrl: typeof release.html_url === "string" ? release.html_url : releasePage(version),
      error: null,
    });
    publish({ type: "update.available", version, releaseNotes });
    return { started: true };
  } catch (error) {
    const message = describeError(error);
    current.logger.warn("Release check failed", { error: message });
    setState({ status: "error", error: message });
    publish({ type: "update.error", message });
    return { started: false };
  }
}

/**
 * Opens the available version's release page in the browser. Only a GitHub
 * release page is ever opened from here.
 */
export async function openReleasePage(): Promise<{ opened: boolean }> {
  const url = state.releaseUrl;
  if (!url || !/^https:\/\/github\.com\/[^/]+\/[^/]+\/releases\//.test(url)) {
    return { opened: false };
  }
  await shell.openExternal(url);
  return { opened: true };
}

/**
 * Downloads the available update. Called only from the explicit download
 * action in Settings, so a metered connection never pays for a fetch the
 * user did not ask for. Never rejects.
 */
export async function downloadUpdate(): Promise<{ started: boolean }> {
  const current = deps;
  if (!current) {
    return { started: false };
  }
  if (!app.isPackaged) {
    current.logger.debug("Skipping update download: app is not packaged");
    return { started: false };
  }
  if (state.availableVersion === null || state.status === "downloaded") {
    current.logger.debug("Skipping update download: no update is available");
    return { started: false };
  }
  if (!state.installsItself) {
    return { started: (await openReleasePage()).opened };
  }
  const updater = await ensureSetup();
  if (!updater) {
    return { started: false };
  }
  try {
    setState({ status: "downloading", progress: 0, error: null });
    await updater.downloadUpdate();
    return { started: true };
  } catch (error) {
    const message = describeError(error);
    current.logger.warn("Update download failed", { error: message });
    setState({ status: "error", error: message });
    publish({ type: "update.error", message });
    return { started: false };
  }
}

/**
 * Installs the downloaded update and restarts. Reached only through the
 * explicit install action in Settings, after the download has finished, so
 * nothing is ever installed silently. Never rejects.
 */
export async function installUpdate(): Promise<{ installing: boolean }> {
  const current = deps;
  if (!current) {
    return { installing: false };
  }
  if (!app.isPackaged) {
    current.logger.debug("Skipping update install: app is not packaged");
    return { installing: false };
  }
  if (state.status !== "downloaded") {
    current.logger.debug("Skipping update install: no downloaded update");
    return { installing: false };
  }
  const updater = await ensureSetup();
  if (!updater) {
    return { installing: false };
  }
  try {
    updater.quitAndInstall();
    return { installing: true };
  } catch (error) {
    const message = describeError(error);
    current.logger.error("Update install failed", { error: message });
    setState({ status: "error", error: message });
    publish({ type: "update.error", message });
    return { installing: false };
  }
}

function setState(patch: Partial<UpdateState>): void {
  state = { ...state, ...patch };
}

function publish(event: AppEvent): void {
  try {
    deps?.publish(event);
  } catch (error) {
    deps?.logger.warn("Update event publish failed", { error: describeError(error) });
  }
}

function ensureSetup(): Promise<AutoUpdaterLike | null> {
  if (!setupPromise) {
    // A failed setup resets the promise so the next check retries instead of
    // reusing the cached null forever.
    setupPromise = setup().then(
      (updater) => {
        if (!updater) {
          setupPromise = null;
        }
        return updater;
      },
      () => {
        setupPromise = null;
        return null;
      },
    );
  }
  return setupPromise;
}

async function setup(): Promise<AutoUpdaterLike | null> {
  const current = deps;
  if (!current) {
    return null;
  }
  try {
    const updater = await loadAutoUpdater();
    if (!updater) {
      return null;
    }
    // Nothing moves without the user: no background fetch, and a downloaded
    // update never applies itself when the app quits.
    updater.autoDownload = false;
    updater.autoInstallOnAppQuit = false;
    attachListeners(updater, current);
    return updater;
  } catch (error) {
    current.logger.warn("Update setup failed", { error: describeError(error) });
    return null;
  }
}

/**
 * Finds the updater instance in a dynamically imported module. electron-updater
 * is CommonJS, so depending on the loader the instance sits top-level, under
 * `default`, or under `module.exports` — checking only one shape is how the
 * update button silently died (no shape matched, every check no-op'd).
 */
export function resolveAutoUpdater(mod: unknown): AutoUpdaterLike | null {
  if (typeof mod !== "object" || mod === null) {
    return null;
  }
  const record = mod as {
    autoUpdater?: unknown;
    default?: unknown;
    ["module.exports"]?: unknown;
  };
  for (const candidate of [record.autoUpdater, record.default, record["module.exports"]]) {
    if (typeof candidate === "object" && candidate !== null) {
      const inner = (candidate as { autoUpdater?: unknown }).autoUpdater;
      const resolved = inner ?? candidate;
      if (isAutoUpdaterLike(resolved)) {
        return resolved;
      }
    }
  }
  return null;
}

async function loadAutoUpdater(): Promise<AutoUpdaterLike | null> {
  try {
    // A variable specifier on purpose (see the interface above): this stays a
    // runtime-only dependency and never breaks typecheck while uninstalled.
    const specifier = "electron-updater";
    const mod: unknown = await import(/* @vite-ignore */ specifier);
    return resolveAutoUpdater(mod);
  } catch {
    return null;
  }
}

function isAutoUpdaterLike(value: unknown): value is AutoUpdaterLike {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    typeof record["checkForUpdates"] === "function" &&
    typeof record["downloadUpdate"] === "function" &&
    typeof record["quitAndInstall"] === "function" &&
    typeof record["on"] === "function"
  );
}

function attachListeners(updater: AutoUpdaterLike, current: UpdaterDeps): void {
  const guard = (name: string, run: () => void): void => {
    try {
      run();
    } catch (error) {
      current.logger.warn("Update listener failed", {
        event: name,
        error: describeError(error),
      });
    }
  };

  updater.on("checking-for-update", () => {
    guard("checking-for-update", () => {
      setState({ status: "checking", error: null });
      publish({ type: "update.checking" });
    });
  });

  updater.on("update-available", (...args) => {
    guard("update-available", () => {
      const parsed = parseUpdateInfo(args[0]);
      if (!parsed) {
        current.logger.warn("Ignoring update without a version");
        return;
      }
      if (!isNewerVersion(parsed.version, state.currentVersion)) {
        // Never offer a downgrade or a reinstall of the running version as an
        // "update": feed mix-ups must not move the app backwards.
        current.logger.warn("Ignoring update that is not newer", {
          available: parsed.version,
          current: state.currentVersion,
        });
        return;
      }
      setState({
        status: "available",
        availableVersion: parsed.version,
        releaseNotes: parsed.releaseNotes,
        releaseUrl: releasePage(parsed.version),
        error: null,
        progress: null,
      });
      publish({
        type: "update.available",
        version: parsed.version,
        releaseNotes: parsed.releaseNotes,
      });
    });
  });

  updater.on("update-not-available", () => {
    guard("update-not-available", () => {
      setState({
        status: "not-available",
        availableVersion: null,
        releaseNotes: null,
        error: null,
        progress: null,
      });
      publish({ type: "update.not-available", version: state.currentVersion });
    });
  });

  updater.on("download-progress", (...args) => {
    guard("download-progress", () => {
      const progress = parseProgress(args[0]);
      setState({ status: "downloading", progress: progress.percent });
      publish({ type: "update.progress", ...progress });
    });
  });

  updater.on("update-downloaded", (...args) => {
    guard("update-downloaded", () => {
      const parsed = parseUpdateInfo(args[0]);
      const version = parsed?.version ?? state.availableVersion ?? state.currentVersion;
      setState({
        status: "downloaded",
        availableVersion: version,
        progress: 100,
        error: null,
      });
      publish({ type: "update.downloaded", version });
    });
  });

  updater.on("error", (...args) => {
    guard("error", () => {
      const message = describeError(args[0]);
      current.logger.warn("Updater reported an error", { error: message });
      setState({ status: "error", error: message });
      publish({ type: "update.error", message });
    });
  });
}

function parseUpdateInfo(value: unknown): {
  version: string;
  releaseNotes: string | null;
} | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const version = record["version"];
  if (typeof version !== "string" || version.length === 0) {
    return null;
  }
  return { version, releaseNotes: normalizeReleaseNotes(record["releaseNotes"]) };
}

/**
 * Notes as plain text. A release's own notes file arrives as written; notes
 * that electron-updater takes from GitHub's release feed arrive as HTML, which
 * Settings would otherwise show tag by tag.
 */
export function plainReleaseNotes(text: string): string {
  if (!/<\/?(p|ul|ol|li|h[1-6]|br|code|a|strong|em|div|pre|blockquote)\b[^>]*>/i.test(text)) {
    return text;
  }
  return text
    .replace(/>\s*\n\s*</g, "><")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<li[^>]*>/gi, "- ")
    .replace(/<\/li>/gi, "\n")
    .replace(/<\/(p|h[1-6]|ul|ol|div|pre|blockquote)>/gi, "\n\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function normalizeReleaseNotes(value: unknown): string | null {
  // Release notes are stored in state and cross the IPC bridge on every
  // update event, so they are capped at 2000 characters — enough for a human
  // to review in Settings, small enough that a huge changelog cannot bloat
  // the renderer store. Longer notes are cut with an ellipsis marker.
  const truncate = (text: string): string => {
    const plain = plainReleaseNotes(text);
    return plain.length > 2000 ? `${plain.slice(0, 2000)}…` : plain;
  };
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length === 0 ? null : truncate(trimmed);
  }
  if (Array.isArray(value)) {
    const parts: string[] = [];
    for (const entry of value) {
      if (typeof entry === "string" && entry.trim().length > 0) {
        parts.push(entry.trim());
      } else if (typeof entry === "object" && entry !== null && "note" in entry) {
        const note = (entry as { note?: unknown }).note;
        if (typeof note === "string" && note.trim().length > 0) {
          parts.push(note.trim());
        }
      }
    }
    if (parts.length === 0) {
      return null;
    }
    return truncate(parts.join("\n\n"));
  }
  return null;
}

function parseProgress(value: unknown): {
  percent: number;
  bytesPerSecond: number;
  transferred: number;
  total: number;
} {
  const none = { percent: 0, bytesPerSecond: 0, transferred: 0, total: 0 };
  if (typeof value !== "object" || value === null) {
    return none;
  }
  const record = value as Record<string, unknown>;
  const numberOr = (field: string): number => {
    const fieldValue = record[field];
    return typeof fieldValue === "number" && Number.isFinite(fieldValue) ? fieldValue : 0;
  };
  const percent = numberOr("percent");
  return {
    percent: Math.min(100, Math.max(0, percent)),
    bytesPerSecond: numberOr("bytesPerSecond"),
    transferred: numberOr("transferred"),
    total: numberOr("total"),
  };
}

function describeError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return typeof error === "string" ? error : "Unknown update error";
}

/**
 * True when `candidate` is strictly newer than `current`. Compares the numeric
 * prefix (`1.2.3`) segment by segment; a pre-release suffix never makes a
 * version newer than the same numbers without one.
 */
function isNewerVersion(candidate: string, current: string): boolean {
  const numbers = (version: string): number[] =>
    version
      .split("+")[0]
      ?.split("-")[0]
      ?.split(".")
      .map((part) => {
        const parsed = Number.parseInt(part, 10);
        return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
      }) ?? [];
  const left = numbers(candidate);
  const right = numbers(current);
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const a = left[index] ?? 0;
    const b = right[index] ?? 0;
    if (a !== b) {
      return a > b;
    }
  }
  return false;
}
