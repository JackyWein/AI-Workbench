import { describe, expect, it } from "vitest";
import { geminiProfile, parseProfile } from "@ai-workbench/provider-cli";

describe("Gemini CLI models", () => {
  it("offers the tool's own aliases, so the picker is never empty", () => {
    // Gemini CLI has no command that lists models. Its aliases are resolved
    // by the tool itself; run against Gemini CLI 0.60 on 2026-09-23, `pro`
    // asked for gemini-3.1-pro-preview, `flash` for gemini-3.5-flash and
    // `flash-lite` for gemini-3.1-flash-lite, and `auto` let its router pick.
    const profile = parseProfile(geminiProfile);
    expect(profile.models.map((model) => model.id)).toEqual(["auto", "pro", "flash", "flash-lite"]);
    expect(profile.models.find((model) => model.isDefault)?.id).toBe("auto");
    expect(profile.modelArgs).toEqual(["--model", "{model}"]);
  });
});
