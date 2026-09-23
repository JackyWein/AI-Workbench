import { describe, expect, it } from "vitest";
import { metricsFromSession, parseSessionList, pickRunSession, statsLimits } from "../index.js";

/** Shaped like `opencode api session.list` of OpenCode 2.0.13. */
const list = JSON.stringify({
  data: [
    {
      id: "ses_new",
      model: { id: "muse-spark-1.3", providerID: "opencode-go", variant: "xhigh" },
      cost: 0.1086,
      tokens: { input: 928720, output: 15869, reasoning: 4367, cache: { read: 5846960, write: 0 } },
      time: { created: 1_790_090_509_888, updated: 1_790_091_594_567 },
      location: { directory: "D:\\Work" },
    },
    {
      id: "ses_old",
      model: { id: "muse-spark-1.3" },
      cost: 1.69,
      tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
      time: { created: 1_790_000_000_000, updated: 1_790_000_100_000 },
    },
  ],
});

describe("OpenCode session API", () => {
  it("reads a session's tokens and cost as OpenCode kept them", () => {
    const sessions = parseSessionList(list);
    expect(sessions).toHaveLength(2);
    const metrics = metricsFromSession(sessions?.[0], new Date(0));
    expect(metrics).toEqual({
      source: "OpenCode session API",
      providerSessionId: "ses_new",
      model: "muse-spark-1.3",
      tokens: { input: 928720, output: 15869, reasoning: 4367, cacheRead: 5846960, cacheWrite: 0 },
      costUsd: 0.1086,
      costEstimated: true,
      limits: [],
      updatedAt: new Date(0),
    });
  });

  it("takes the session the run created, never an older one", () => {
    const sessions = parseSessionList(list) ?? [];
    expect(pickRunSession(sessions, new Date(1_790_090_505_000))).toMatchObject({ id: "ses_new" });
    expect(pickRunSession(sessions, new Date(1_790_099_000_000))).toBeUndefined();
  });

  it("rejects output that is not a session list", () => {
    expect(parseSessionList("<!doctype html>")).toBeNull();
    expect(parseSessionList('{"data":{}}')).toBeNull();
  });

  it("reports today's and this week's amounts, not a made-up quota", () => {
    const today = { tokens: { input: 10, output: 5, reasoning: 1, cache: { read: 9, write: 0 } }, cost: 0.2 };
    const week = { tokens: { input: 100, output: 50, reasoning: 0, cache: { read: 0, write: 0 } }, cost: 3 };
    expect(statsLimits(today, week)).toEqual([
      { id: "today.tokens", label: "Tokens today", used: 16, unit: "tokens" },
      { id: "today.cost", label: "Cost today", used: 0.2, unit: "usd" },
      { id: "week.tokens", label: "Tokens · 7 days", used: 150, unit: "tokens" },
      { id: "week.cost", label: "Cost · 7 days", used: 3, unit: "usd" },
    ]);
    expect(statsLimits(null, null)).toEqual([]);
  });
});
