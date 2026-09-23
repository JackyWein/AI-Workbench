import { describe, expect, it } from "vitest";
import { plainReleaseNotes, resolveAutoUpdater, selfInstall } from "../updater.js";

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
});
