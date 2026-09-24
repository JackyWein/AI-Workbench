import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { AppEvent } from "@ai-workbench/shared";

/*
 * The restart question for a downloaded update, through the updater's own
 * flow with a stand-in for electron-updater: "Later" is remembered until the
 * next download, and "Restart now" runs the installer without its wizard and
 * starts the app again afterwards.
 */

const listeners = new Map<string, (...args: unknown[]) => void>();
const fake = {
  autoDownload: false,
  autoInstallOnAppQuit: false,
  checkForUpdates: vi.fn(() => Promise.resolve({})),
  downloadUpdate: vi.fn(() => Promise.resolve([])),
  quitAndInstall: vi.fn(),
  on: (event: string, listener: (...args: unknown[]) => void) => {
    listeners.set(event, listener);
  },
};

vi.mock("electron", () => ({
  app: { isPackaged: true },
  net: { fetch: vi.fn() },
  shell: { openExternal: vi.fn() },
}));

const { checkForUpdates, deferInstall, getUpdateState, initUpdater, installUpdate } = await import(
  "../updater.js"
);

const events: AppEvent[] = [];
const logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => logger,
};
const platform = Object.getOwnPropertyDescriptor(process, "platform");

beforeAll(() => {
  // A build that installs its own updates: the Windows setup version.
  Object.defineProperty(process, "platform", { value: "win32" });
  initUpdater({
    logger,
    publish: (event) => events.push(event),
    currentVersion: "0.0.6",
    currentCommit: "e4e8dbe6a3b0c9d1f2e3a4b5c6d7e8f9a0b1c2d3",
    automatic: true,
    loadModule: () => Promise.resolve({ autoUpdater: fake }),
  });
});

afterAll(() => {
  if (platform) {
    Object.defineProperty(process, "platform", platform);
  }
});

function download(version: string): void {
  listeners.get("update-available")?.({ version, files: [] });
  listeners.get("update-downloaded")?.({ version, files: [] });
}

describe("restarting for a downloaded update", () => {
  it("downloads in the background and then asks", async () => {
    await checkForUpdates();
    expect(fake.autoDownload).toBe(true);
    expect(fake.autoInstallOnAppQuit).toBe(true);
    download("0.0.7");
    expect(getUpdateState()).toMatchObject({ status: "downloaded", availableVersion: "0.0.7", deferred: false });
  });

  it("remembers Later until the next download", () => {
    expect(deferInstall()).toEqual({ deferred: true });
    expect(getUpdateState().deferred).toBe(true);
    expect(events).toContainEqual({ type: "update.deferred", version: "0.0.7" });
    download("0.0.8");
    expect(getUpdateState()).toMatchObject({ availableVersion: "0.0.8", deferred: false });
  });

  it("installs without the setup wizard and starts the app again", async () => {
    expect(await installUpdate()).toEqual({ installing: true });
    expect(fake.quitAndInstall).toHaveBeenCalledWith(true, true);
  });

  it("has nothing to put off when nothing is downloaded", () => {
    listeners.get("update-not-available")?.({ version: "0.0.8" });
    expect(deferInstall()).toEqual({ deferred: false });
  });
});
