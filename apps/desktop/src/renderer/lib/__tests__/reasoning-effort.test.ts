import { describe, expect, it } from "vitest";
import type { ProviderSummary } from "@ai-workbench/shared";
import { needsEffortConfirmation, reasoningEffortsFor } from "../reasoning-effort.js";

const provider = {
  metadata: { effortOptions: ["low", "medium", "high", "xhigh", "max"] },
  models: [
    { id: "wide", reasoningEfforts: ["low", "medium", "high", "xhigh", "max", "ultra"] },
    { id: "small", reasoningEfforts: ["low", "medium"] },
    { id: "profile" },
  ],
} as ProviderSummary;

describe("reasoning effort choices", () => {
  it("uses the model's reported levels before tool-wide profile levels", () => {
    expect(reasoningEffortsFor(provider, "wide")).toEqual(["low", "medium", "high", "xhigh", "max", "ultra"]);
    expect(reasoningEffortsFor(provider, "small")).toEqual(["low", "medium"]);
    expect(reasoningEffortsFor(provider, "profile")).toEqual(["low", "medium", "high", "xhigh", "max"]);
  });

  it("warns only for max and ultra", () => {
    expect(needsEffortConfirmation("high")).toBe(false);
    expect(needsEffortConfirmation("max")).toBe(true);
    expect(needsEffortConfirmation("ultra")).toBe(true);
  });
});
