import { describe, expect, it } from "vitest";
import type { ProviderSummary } from "@ai-workbench/shared";
import { draftingProviders, initialDraftChoice } from "../draft-choice.js";

function provider(id: string, fields: Partial<ProviderSummary> = {}): ProviderSummary {
  return {
    metadata: { id, displayName: id, adapterVersion: "1", authMethods: ["none"], transportTypes: ["cli"] },
    enabled: true,
    installation: { state: "installed" },
    auth: { state: "authenticated", method: "cli" },
    capabilities: { supported: ["chat"] },
    models: [
      { id: "fast", displayName: "Fast" },
      { id: "deep", displayName: "Deep", reasoningEfforts: ["low", "high"] },
    ],
    ...fields,
  } as unknown as ProviderSummary;
}

describe("what a draft runs on", () => {
  const usable = [provider("tool-a"), provider("tool-b")];

  it("starts from the remembered tool, model and effort", () => {
    const stored = JSON.stringify({ providerId: "tool-b", modelId: "deep", effort: "high" });
    expect(initialDraftChoice("skill", usable, stored)).toEqual({
      providerId: "tool-b",
      modelId: "deep",
      effort: "high",
    });
  });

  it("drops what no longer exists instead of sending it", () => {
    expect(
      initialDraftChoice("skill", usable, JSON.stringify({ providerId: "tool-b", modelId: "gone", effort: "high" })),
    ).toEqual({ providerId: "tool-b", modelId: "", effort: "" });
    expect(
      initialDraftChoice("skill", usable, JSON.stringify({ providerId: "tool-b", modelId: "fast", effort: "high" })),
    ).toEqual({ providerId: "tool-b", modelId: "fast", effort: "" });
    expect(initialDraftChoice("skill", usable, JSON.stringify({ providerId: "uninstalled" }))).toEqual({
      providerId: "tool-a",
      modelId: "",
      effort: "",
    });
    expect(initialDraftChoice("skill", usable, "not json")).toEqual({ providerId: "tool-a", modelId: "", effort: "" });
  });

  it("offers only tools that can draft now", () => {
    const tools = [
      provider("ready"),
      provider("off", { enabled: false }),
      provider("missing", { installation: { state: "notInstalled" } } as Partial<ProviderSummary>),
      provider("signed-out", { auth: { state: "authenticationRequired", method: "cli" } } as Partial<ProviderSummary>),
    ];
    expect(draftingProviders(tools).map((entry) => entry.metadata.id)).toEqual(["ready"]);
  });
});
