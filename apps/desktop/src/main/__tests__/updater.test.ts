import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import {
  acceptNewBuilds,
  isNewerBuild,
  plainReleaseNotes,
  resolveAutoUpdater,
  selfInstall,
} from "../updater.js";

function fakeUpdater(): Record<string, unknown> {
  return {
    autoDownload: false,
    autoInstallOnAppQuit: false,
    checkForUpdates: () => Promise.resolve(null),
    downloadUpdate: () => Promise.resolve(null),
    quitAndInstall: () => {},
    on: () => {},
  };
}

describe("resolveAutoUpdater", () => {
  it("accepts a top-level instance", () => {
    expect(resolveAutoUpdater({ autoUpdater: fakeUpdater() })).not.toBeNull();
  });

  it("accepts the CommonJS default-export shape", () => {
    expect(resolveAutoUpdater({ default: { autoUpdater: fakeUpdater() } })).not.toBeNull();
  });

  it("accepts the module.exports shape", () => {
    expect(resolveAutoUpdater({ "module.exports": { autoUpdater: fakeUpdater() } })).not.toBeNull();
  });

  it("rejects anything without the updater surface", () => {
    expect(resolveAutoUpdater(null)).toBeNull();
    expect(resolveAutoUpdater({})).toBeNull();
    expect(resolveAutoUpdater({ autoUpdater: { checkForUpdates: () => {} } })).toBeNull();
  });

  it("resolves the real electron-updater package shape", () => {
    // The real package is CommonJS: `import()` yields a namespace whose
    // `default` holds the exports with `autoUpdater` among them. The getter
    // behind it instantiates platform code, so this mimics the shape with a
    // stub instead of touching Electron APIs in the test runner.
    expect(
      resolveAutoUpdater({ __esModule: true, default: { autoUpdater: fakeUpdater() } }),
    ).not.toBeNull();
  });
});

describe("release notes", () => {
  it("keeps notes that are text as they are", () => {
    expect(plainReleaseNotes("AI Workbench 0.0.4\n\n- One <thing> & more")).toBe(
      "AI Workbench 0.0.4\n\n- One <thing> & more",
    );
  });

  it("turns notes from GitHub's release feed into text", () => {
    const html =
      "<h3>Every agent on the island</h3>\n<ul>\n<li>Codex &amp; OpenCode</li>\n<li>Gemini CLI</li>\n</ul>\n<p>Known <code>limits</code></p>";
    expect(plainReleaseNotes(html)).toBe(
      "Every agent on the island\n\n- Codex & OpenCode\n- Gemini CLI\n\nKnown limits",
    );
  });
});

describe("which builds update themselves", () => {
  it("installs over the Windows setup version and the AppImage", () => {
    expect(selfInstall("win32", {}).installsItself).toBe(true);
    expect(selfInstall("linux", { APPIMAGE: "/home/me/AI-Workbench.AppImage" }).installsItself).toBe(true);
  });

  it("sends the portable version, the unsigned Mac build and a Linux archive to the release page", () => {
    const portable = selfInstall("win32", { PORTABLE_EXECUTABLE_FILE: "D:\\AI-Workbench.exe" });
    expect(portable.installsItself).toBe(false);
    expect(portable.reason).toMatch(/portable/);
    expect(selfInstall("darwin", {}).reason).toMatch(/signed/);
    expect(selfInstall("linux", {}).reason).toMatch(/AppImage/);
  });

  it("lets a Mac build signed with a Developer ID install its own updates", () => {
    expect(selfInstall("darwin", {}, true)).toEqual({ installsItself: true, reason: null });
  });
});

describe("what counts as an update", () => {
  const running = { version: "0.0.6", commit: "e4e8dbebca417a1886b829209436db76fa5b6772" };

  it("takes a newer version, whatever its commit", () => {
    expect(isNewerBuild({ version: "0.0.7", commit: null }, running)).toBe(true);
    expect(isNewerBuild({ version: "0.1.0", commit: running.commit }, running)).toBe(true);
  });

  it("takes the same version made from another commit", () => {
    expect(isNewerBuild({ version: "0.0.6", commit: "5c990e66362cdac0666ed05541df18a3954847d9" }, running)).toBe(
      true,
    );
  });

  it("does not take the build that is running, however its commit is written", () => {
    expect(isNewerBuild({ version: "0.0.6", commit: running.commit }, running)).toBe(false);
    expect(isNewerBuild({ version: "0.0.6", commit: "E4E8DBE" }, running)).toBe(false);
  });

  it("never goes back, and never guesses without both commits", () => {
    expect(isNewerBuild({ version: "0.0.5", commit: "5c990e66362cdac0666ed05541df18a3954847d9" }, running)).toBe(
      false,
    );
    expect(isNewerBuild({ version: "0.0.6", commit: null }, running)).toBe(false);
    expect(isNewerBuild({ version: "0.0.6", commit: "5c990e6" }, { version: "0.0.6", commit: "" })).toBe(false);
    expect(isNewerBuild({ version: "0.0.6", commit: "main" }, running)).toBe(false);
  });

  it("opens electron-updater's gate for a new build of the same version only", async () => {
    // electron-updater's own gate refuses every release of the running version.
    const updater: { isUpdateAvailable?: (info: unknown) => Promise<boolean> } = {
      isUpdateAvailable: (info) => Promise.resolve((info as { version: string }).version === "0.0.7"),
    };
    acceptNewBuilds(updater, running);
    const gate = updater.isUpdateAvailable;
    expect(await gate?.({ version: "0.0.7" })).toBe(true);
    expect(await gate?.({ version: "0.0.6", commit: "5c990e66362cdac0666ed05541df18a3954847d9" })).toBe(true);
    expect(await gate?.({ version: "0.0.6", commit: running.commit })).toBe(false);
    expect(await gate?.({ version: "0.0.6" })).toBe(false);
    expect(await gate?.({ version: "0.0.5", commit: "5c990e6" })).toBe(false);
  });

  it("opens the real electron-updater's gate the same way", async () => {
    // The installed package's own class, outside Electron: it refuses the
    // running version outright, which is what the wrapper is for.
    const require = createRequire(import.meta.url);
    const { AppUpdater } = require("electron-updater/out/AppUpdater.js") as {
      AppUpdater: new (options: null, app: unknown) => { isUpdateAvailable: (info: unknown) => Promise<boolean> };
    };
    class Probe extends AppUpdater {
      doDownloadUpdate(): void {}
      doInstall(): boolean {
        return true;
      }
    }
    const app = {
      version: "0.0.6",
      name: "AI Workbench",
      isPackaged: true,
      appUpdateConfigPath: "/nonexistent/app-update.yml",
      userDataPath: tmpdir(),
      baseCachePath: tmpdir(),
      onQuit: () => {},
      quit: () => {},
      relaunch: () => {},
    };
    const updater = new Probe(null, app);
    const newBuild = { version: "0.0.6", files: [], commit: "5c990e66362cdac0666ed05541df18a3954847d9" };
    expect(await updater.isUpdateAvailable(newBuild)).toBe(false);
    acceptNewBuilds(updater, running);
    expect(await updater.isUpdateAvailable(newBuild)).toBe(true);
    expect(await updater.isUpdateAvailable({ ...newBuild, commit: running.commit })).toBe(false);
    expect(await updater.isUpdateAvailable({ version: "0.0.7", files: [] })).toBe(true);
  });
});
