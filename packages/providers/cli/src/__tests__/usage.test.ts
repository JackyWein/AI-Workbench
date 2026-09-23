import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeTempDirectory, removeTempDirectory } from "@ai-workbench/test-support";
import { UsageStore } from "../usage.js";

const nullLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => nullLogger,
};

const fiveHour = {
  id: "five_hour",
  label: "5-hour window",
  used: 28,
  remaining: 72,
  total: 100,
  unit: "percent" as const,
  resetsAt: new Date("2026-09-23T06:30:00Z"),
};
const limits = [fiveHour];

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 50));
}

describe("UsageStore", () => {
  let directory: string;

  beforeEach(async () => {
    directory = await makeTempDirectory("usage-store-");
  });

  afterEach(async () => {
    await removeTempDirectory(directory);
  });

  it("says usage is unknown until the tool reports it", async () => {
    const store = new UsageStore({ providerId: "tool", logger: nullLogger, onChange: () => {} });
    expect(await store.get()).toMatchObject({ state: "unavailable", limits: [] });
  });

  it("remembers the last report across a restart, with its original time", async () => {
    const reportedAt = new Date("2026-09-23T01:00:00Z");
    const first = new UsageStore({ providerId: "tool", logger: nullLogger, onChange: () => {} });
    await first.load(directory);
    first.observeTurn(limits, reportedAt);
    await settle();

    const second = new UsageStore({ providerId: "tool", logger: nullLogger, onChange: () => {} });
    await second.load(directory);
    const usage = await second.get();
    expect(usage).toMatchObject({ state: "available", updatedAt: reportedAt });
    expect(usage.limits).toEqual(limits);
  });

  it("prefers a newer report over the remembered one", async () => {
    const first = new UsageStore({ providerId: "tool", logger: nullLogger, onChange: () => {} });
    await first.load(directory);
    first.observeTurn(limits, new Date("2026-09-23T01:00:00Z"));
    await settle();

    const second = new UsageStore({ providerId: "tool", logger: nullLogger, onChange: () => {} });
    await second.load(directory);
    const newer = [{ ...fiveHour, used: 40, remaining: 60 }];
    second.observeTurn(newer, new Date("2026-09-23T02:00:00Z"));
    expect((await second.get()).limits[0]?.used).toBe(40);
  });
});
