import { describe, expect, it } from "vitest";
import { resolveAutoUpdater } from "../updater.js";

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
