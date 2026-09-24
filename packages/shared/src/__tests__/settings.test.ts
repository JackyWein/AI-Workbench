import { describe, expect, it } from "vitest";
import { appSettingsSchema, defaultAppSettings, upgradeStoredSettings } from "../domain/settings.js";

/** Settings as 0.0.6 and earlier stored them: the mode inside the theme. */
function stored(theme: string): Record<string, unknown> {
  const { mode: _mode, ...rest } = defaultAppSettings;
  return { ...rest, theme };
}

describe("settings from an earlier version", () => {
  it("reads Quiet's old choices as Quiet in that mode", () => {
    for (const mode of ["system", "dark", "light"] as const) {
      const settings = appSettingsSchema.parse(upgradeStoredSettings(stored(mode)));
      expect(settings.theme).toBe("quiet");
      expect(settings.mode).toBe(mode);
    }
  });

  it("keeps another theme in the mode it came in", () => {
    const expected = { atelier: "light", mission: "dark", playground: "light", aurora: "dark", swiss: "light" };
    for (const [theme, mode] of Object.entries(expected)) {
      const settings = appSettingsSchema.parse(upgradeStoredSettings(stored(theme)));
      expect(settings.theme).toBe(theme);
      expect(settings.mode).toBe(mode);
    }
  });

  it("leaves current settings as they are", () => {
    const current = { ...defaultAppSettings, theme: "swiss", mode: "dark" };
    expect(upgradeStoredSettings(current)).toEqual(current);
  });

  it("passes anything else through for the schema to refuse", () => {
    expect(upgradeStoredSettings(null)).toBeNull();
    expect(appSettingsSchema.safeParse(upgradeStoredSettings(stored("neon"))).success).toBe(false);
  });
});
