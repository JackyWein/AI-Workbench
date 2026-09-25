import { describe, expect, it } from "vitest";
import type { Session, TeamRun } from "@ai-workbench/shared";
import { ownRunOf } from "../session-team-run.js";

type SessionLike = Pick<Session, "id" | "workspaceId" | "uiState" | "createdAt">;

function session(id: string, workspaceId: string, uiState: Record<string, unknown> = {}, at = 0): SessionLike {
  return { id, workspaceId, uiState, createdAt: new Date(at) };
}

function run(id: string, fields: Partial<TeamRun> = {}): TeamRun {
  return {
    id,
    teamId: "team",
    workspaceId: "ws",
    sessionId: null,
    goal: "goal",
    status: "completed",
    stopReason: "goalFinished",
    outcome: null,
    sharedState: { goal: "goal", summary: "", currentPlan: null, importantContext: [] },
    limits: {} as TeamRun["limits"],
    agentCalls: 0,
    failures: 0,
    messageCount: 0,
    createdAt: new Date(0),
    startedAt: null,
    finishedAt: null,
    ...fields,
  };
}

describe("the run a session shows of its team", () => {
  it("is nothing for a new session, even with the team's runs in the same workspace", () => {
    const first = session("s1", "ws", { teamId: "team", teamRunId: "r1" });
    const fresh = session("s2", "ws");
    const runs = [run("r1", { sessionId: "s1" })];
    expect(ownRunOf(fresh, "team", runs, [first, fresh])).toBeNull();
  });

  it("is nothing for a session in another workspace", () => {
    const elsewhere = session("s3", "other");
    const runs = [run("r1", { sessionId: "s1", status: "running" })];
    expect(ownRunOf(elsewhere, "team", runs, [elsewhere])).toBeNull();
  });

  it("is the run the session started, kept when the team is picked again", () => {
    const own = session("s1", "ws", { teamId: "team", teamRunId: "r1" });
    const runs = [run("r2", { sessionId: "s2" }), run("r1", { sessionId: "s1" })];
    expect(ownRunOf(own, "team", runs, [own])?.id).toBe("r1");
  });

  it("finds the session's own run again after it switched to another team and back", () => {
    const own = session("s1", "ws", { teamId: "other-team", teamRunId: "x" });
    const runs = [
      run("r3", { sessionId: "s2" }),
      run("r2", { sessionId: "s1" }),
      run("r1", { sessionId: "s1", status: "paused" }),
    ];
    expect(ownRunOf(own, "team", runs, [own])?.id).toBe("r1");
  });

  it("never keeps showing another session's run it was once handed", () => {
    const wrong = session("s2", "ws", { teamId: "team", teamRunId: "r1" });
    const runs = [run("r1", { sessionId: "s1" })];
    expect(ownRunOf(wrong, "team", runs, [wrong])).toBeNull();
  });

  it("gives a run from before runs knew their session to the first session that showed it", () => {
    const first = session("s1", "ws", { teamId: "team", teamRunId: "old" }, 1);
    const later = session("s2", "ws", { teamId: "team", teamRunId: "old" }, 2);
    const moved = session("s3", "elsewhere", { teamId: "team", teamRunId: "old" }, 0);
    const runs = [run("old")];
    expect(ownRunOf(first, "team", runs, [first, later])?.id).toBe("old");
    expect(ownRunOf(later, "team", runs, [first, later])).toBeNull();
    expect(ownRunOf(moved, "team", runs, [moved])).toBeNull();
  });
});
