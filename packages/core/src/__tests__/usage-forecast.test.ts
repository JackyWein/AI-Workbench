import { describe, expect, it } from "vitest";
import type { ProviderUsageSnapshot } from "@ai-workbench/shared";
import { UsageForecaster } from "../usage-forecast.js";

const start = Date.parse("2026-09-25T12:00:00Z");
function sample(minute: number, used: number, overrides: Partial<ProviderUsageSnapshot> = {}): ProviderUsageSnapshot {
  return { providerId: "tool", state: "available", source: "provider", updatedAt: new Date(start + minute * 60_000), limits: [{ id: "window", label: "Window", unit: "percent", used, resetsAt: new Date(start + 3_600_000) }], ...overrides };
}
const record = (forecast: UsageForecaster, minute: number, used: number, overrides: Partial<ProviderUsageSnapshot> = {}) => forecast.observe(sample(minute, used, overrides), start + minute * 60_000).limits[0]?.forecast;

describe("reported usage forecast", () => {
  it("needs three distinct reports over ten minutes and projects only before the reset", () => {
    const f = new UsageForecaster();
    expect(record(f, 0, 40)).toBeUndefined();
    expect(record(f, 5, 50)).toBeUndefined();
    const result = record(f, 10, 60);
    expect(result?.exhaustsAt.toISOString()).toBe("2026-09-25T12:30:00.000Z");
    expect(result?.samples).toBe(3);
  });
  it("does not invent pace from cached timestamps or unchanged consumption", () => {
    const f = new UsageForecaster();
    record(f, 0, 40);
    record(f, 0, 40);
    expect(record(f, 10, 60)).toBeUndefined();
    const idle = new UsageForecaster();
    record(idle, 0, 40); record(idle, 5, 40);
    expect(record(idle, 10, 40)).toBeUndefined();
  });
  it("clears history on decrease, reset, stale data, missing reports and long gaps", () => {
    for (const mode of ["decrease", "reset", "gap", "unavailable", "estimated", "stale"] as const) {
      const f = new UsageForecaster();
      record(f, 0, 40); record(f, 5, 50);
      const next = sample(10, 60);
      if (mode === "decrease") next.limits[0]!.used = 5;
      if (mode === "reset") next.limits[0]!.resetsAt = new Date(start + 5 * 3_600_000);
      if (mode === "unavailable" || mode === "estimated") next.state = mode;
      if (mode === "gap") next.updatedAt = new Date(start + 30 * 60_000);
      expect(f.observe(next, start + (mode === "stale" || mode === "gap" ? 30 : 10) * 60_000).limits[0]?.forecast).toBeUndefined();
    }
  });
  it("does not forecast beyond reset or mix accounts", () => {
    const f = new UsageForecaster();
    record(f, 0, 10); record(f, 5, 11);
    expect(record(f, 10, 12)).toBeUndefined();
    expect(record(f, 15, 80, { providerId: "other" })).toBeUndefined();
  });
  it("supports reported totals and remaining amounts without a percentage", () => {
    const f = new UsageForecaster();
    for (const minute of [0, 5, 10]) {
      const s = sample(minute, 0);
      s.limits = [{ id: "requests", label: "Requests", unit: "requests", total: 200, remaining: 120 - minute * 4, resetsAt: new Date(start + 3_600_000) }];
      const result = f.observe(s, start + minute * 60_000);
      if (minute === 10) expect(result.limits[0]?.forecast?.exhaustsAt.toISOString()).toBe("2026-09-25T12:30:00.000Z");
    }
  });
});
