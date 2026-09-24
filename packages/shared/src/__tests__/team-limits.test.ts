import { describe, expect, it } from "vitest";
import { teamRunConfigSchema, upgradeRunLimits } from "../domain/team.js";

describe("team run limits", () => {
  it("give a run four hours, and a turn fifteen quiet minutes, by default", () => {
    const limits = teamRunConfigSchema.parse({});
    expect(limits.maxRuntimeMinutes).toBe(240);
    expect(limits.agentTurnSilenceSeconds).toBe(900);
  });

  it("replace the old defaults nobody chose, and keep what was set on purpose", () => {
    const stored = teamRunConfigSchema.parse({ maxRuntimeMinutes: 60, agentTurnSilenceSeconds: 600 });
    expect(upgradeRunLimits(stored)).toMatchObject({ maxRuntimeMinutes: 240, agentTurnSilenceSeconds: 900 });
    const chosen = teamRunConfigSchema.parse({ maxRuntimeMinutes: 30, agentTurnSilenceSeconds: 120 });
    expect(upgradeRunLimits(chosen)).toMatchObject({ maxRuntimeMinutes: 30, agentTurnSilenceSeconds: 120 });
  });
});
