import { copyFile, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeTempDirectory, removeTempDirectory } from "@ai-workbench/test-support";
import { applyRolloutRecord, rateLimitsOf, readRolloutUsage } from "../rollout.js";

const fixture = join(import.meta.dirname, "fixtures", "rollout.jsonl");

async function records(): Promise<unknown[]> {
  const text = await readFile(fixture, "utf8");
  return text
    .split("\n")
    .filter((line) => line.trim())
    .map((line): unknown => JSON.parse(line));
}

describe("Codex rollouts", () => {
  let root: string;

  beforeEach(async () => {
    root = await makeTempDirectory("codex-rollout-");
  });

  afterEach(async () => {
    await removeTempDirectory(root);
  });

  it("reads session totals, context and limits the way Codex reported them", async () => {
    const state = { limits: [] };
    for (const record of await records()) {
      applyRolloutRecord(state, record, "codex");
    }
    expect(state).toMatchObject({
      sessionId: "01a0c96d-cd35-7571-b427-3311bf8ada44",
      model: "gpt-5.6-sol",
      tokens: {
        input: 17891685 - 17577856,
        cacheRead: 17577856,
        output: 83214,
        reasoning: 13047,
      },
      context: { usedTokens: 32567, windowTokens: 258400 },
    });
    expect(state.limits).toEqual([
      expect.objectContaining({ id: "codex.primary", label: "5 hour window", used: 71, windowMinutes: 300 }),
      expect.objectContaining({ id: "codex.secondary", label: "Weekly", used: 11, windowMinutes: 10080 }),
    ]);
  });

  it("ignores a token count without limits rather than inventing them", () => {
    expect(rateLimitsOf({ type: "token_count", info: {} })).toBeNull();
    expect(rateLimitsOf({ type: "token_count", rate_limits: { primary: null } })).toBeNull();
  });

  it("reads the account usage last reported in the newest session", async () => {
    const day = join(root, "2026", "09", "22");
    await mkdir(day, { recursive: true });
    await copyFile(fixture, join(day, "rollout-2026-09-22T16-03-31-01a0c96d.jsonl"));

    const usage = await readRolloutUsage(root, "codex");
    expect(usage).toMatchObject({
      providerId: "codex",
      state: "available",
      plan: "Plus",
      updatedAt: new Date("2026-09-22T15:22:09.908Z"),
    });
    expect(usage?.limits.map((limit) => limit.used)).toEqual([71, 11]);
  });

  it("says nothing when there are no sessions", async () => {
    expect(await readRolloutUsage(join(root, "missing"), "codex")).toBeNull();
  });
});
