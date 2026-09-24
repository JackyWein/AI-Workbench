import { describe, expect, it } from "vitest";
import type { IslandUsageRow } from "@ai-workbench/shared";
import { usageByProvider } from "../usage.js";

const row = (providerId: string, window: string, percentLeft: number | null): IslandUsageRow => ({
  providerId, name: providerId, icon: null, window, percentLeft, note: percentLeft === null ? "No limit reported" : "",
});

describe("island usage in its docked and bubble views", () => {
  it("keeps five-hour and weekly limits as two lines under the same provider", () => {
    const groups = usageByProvider([
      row("claude", "5-hour window", 95),
      row("claude", "Weekly", 87),
      row("codex", "5-hour window", 63),
      row("codex", "Weekly", 22),
      row("other", "", null),
    ]);
    expect(groups.map((group) => [group.providerId, group.limits.map((limit) => limit.window)])).toEqual([
      ["claude", ["5-hour window", "Weekly"]],
      ["codex", ["5-hour window", "Weekly"]],
      ["other", [""]],
    ]);
  });
});
