import { describe, expect, it } from "vitest";
import { buildTeamReply, readTeamPrompt } from "../team-reply.js";

function prompt(options: {
  agentId: string;
  lead?: boolean;
  mates?: string[];
  task?: string | null;
  goal?: string;
}): string {
  const { agentId, lead = false, mates = [], task = null, goal = "Ship the thing" } = options;
  const sections = [
    `GOAL\n${goal}`,
    `YOU\n${agentId} — Member\nYou are ${lead ? "the lead agent" : "a team member"}.`,
    mates.length > 0 ? `TEAM\n${mates.join("\n")}` : null,
    task ? `YOUR TASK\n${task}\nFinish it with complete_task, or fail_task if it cannot be done.` : null,
  ].filter((section): section is string => section !== null);
  return `${sections.join("\n\n")}\n\n\`\`\`team`;
}

describe("team reply markers", () => {
  it("reads the marked lead out of the team section", () => {
    const parsed = readTeamPrompt(
      prompt({
        agentId: "worker-a",
        mates: ["lead-id Lead — plans (lead)", "worker-a Member", "worker-b Member — builds"],
        task: "task-1: Do the thing",
      }),
    );
    expect(parsed.leadId).toBe("lead-id");
    expect(parsed.others).toEqual(["lead-id", "worker-b"]);
  });

  it("leaves the lead unknown when the prompt does not mark one", () => {
    const parsed = readTeamPrompt(
      prompt({
        agentId: "worker-a",
        mates: ["lead-id Lead", "worker-a Member"],
        task: "task-1: Do the thing",
      }),
    );
    expect(parsed.leadId).toBeNull();
  });

  it("completes the task when the goal carries no marker", () => {
    const reply = buildTeamReply(
      prompt({
        agentId: "worker-a",
        mates: ["lead-id Lead (lead)", "worker-a Member"],
        task: "task-1: Do the thing",
      }),
    );
    expect(reply).toContain('"action": "complete_task"');
    expect(reply).not.toContain("fail_task");
    expect(reply).not.toContain("send_message");
  });

  it("fails the task when the goal carries [fail:]", () => {
    const reply = buildTeamReply(
      prompt({
        agentId: "worker-a",
        mates: ["lead-id Lead (lead)", "worker-a Member"],
        task: "task-1: Do the thing",
        goal: "Ship the thing [fail: the API is down]",
      }),
    );
    expect(reply).toContain('"action": "fail_task"');
    expect(reply).toContain("the API is down");
    expect(reply).not.toContain("complete_task");
  });

  it("asks a mate when the goal carries [ask:] and completes the task", () => {
    const reply = buildTeamReply(
      prompt({
        agentId: "worker-a",
        mates: ["lead-id Lead (lead)", "worker-a Member", "worker-b Member"],
        task: "task-1: Do the thing",
        goal: "Ship the thing [ask: is the API contract final?]",
      }),
    );
    expect(reply).toContain('"action": "complete_task"');
    expect(reply).toContain('"action": "send_message"');
    expect(reply).toContain('"type": "question"');
    expect(reply).toContain('"to": "worker-b"');
    expect(reply).toContain("is the API contract final?");
  });

  it("falls back to requesting help when no mate besides the lead exists", () => {
    const reply = buildTeamReply(
      prompt({
        agentId: "worker-a",
        mates: ["lead-id Lead (lead)", "worker-a Member"],
        task: "task-1: Do the thing",
        goal: "Ship the thing [ask: is the API contract final?]",
      }),
    );
    expect(reply).toContain('"action": "request_help"');
  });
});
