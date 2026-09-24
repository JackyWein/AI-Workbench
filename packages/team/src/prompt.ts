import { agentInstructions, type AgentDefinition, type TeamMessage, type TeamTask } from "@ai-workbench/shared";
import { TEAM_PROTOCOL_INSTRUCTIONS } from "./protocol.js";
import type { TeamService } from "./service.js";

/**
 * What an agent is given for one turn.
 *
 * Deliberately bounded: the shared state, its own task, its unread mail and the
 * protocol — never the other agents' conversations (spec §47).
 */
export function buildAgentPrompt(input: {
  readonly service: TeamService;
  readonly agent: AgentDefinition;
  readonly isLead: boolean;
  readonly task: TeamTask | null;
  readonly inbox: readonly TeamMessage[];
  readonly note?: string;
}): string {
  const { service, agent, isLead, task, inbox } = input;
  const state = service.getState();
  const sections: string[] = [];

  sections.push(`GOAL\n${service.getGoal()}`);
  sections.push(
    `YOU\n${agent.id} — ${agent.displayName}${agent.role ? `\nRole: ${agent.role}` : ""}` +
      `\nYou are ${isLead ? "the lead agent" : "a team member"}.`,
  );
  // How this member works in its role, as the person set it for the team.
  const own = agentInstructions(agent);
  if (own) {
    sections.push(`HOW YOU WORK\n${own}`);
  }
  // Members know who leads, so a question can go to a mate that is actually
  // there instead of interrupting the lead by default.
  const leadId = service.team.leadAgentId;
  const members = service.listAgents();
  sections.push(
    `TEAM\n${members.length > 0
      ? members
          .map(
            (member) =>
              `${member.id} ${member.displayName}${member.role ? ` — ${member.role}` : ""}` +
              (member.id === leadId ? " (lead)" : ""),
          )
          .join("\n")
      : "You are working alone."}`,
  );

  if (state.summary) {
    sections.push(`WHAT HAS HAPPENED\n${state.summary}`);
  }
  if (state.currentPlan) {
    sections.push(`CURRENT PLAN\n${state.currentPlan}`);
  }
  if (state.importantContext.length > 0) {
    sections.push(`IMPORTANT CONTEXT\n${state.importantContext.join("\n")}`);
  }
  if (state.tasks.length > 0) {
    sections.push(`TASKS\n${state.tasks.join("\n")}`);
  }
  if (state.decisions.length > 0) {
    sections.push(`DECISIONS\n${state.decisions.join("\n")}`);
  }
  if (state.artifacts.length > 0) {
    sections.push(`ARTIFACTS\n${state.artifacts.join("\n")}`);
  }

  if (inbox.length > 0) {
    sections.push(
      `MESSAGES FOR YOU\n${inbox
        .map((message) => `from ${message.from} (${message.type}): ${message.content}`)
        .join("\n")}`,
    );
  }

  if (task) {
    sections.push(
      `YOUR TASK\n${task.id}: ${task.title}` +
        (task.description ? `\n${task.description}` : "") +
        `\nFinish it with complete_task, or fail_task if it cannot be done.`,
    );
  } else if (isLead) {
    sections.push(
      "YOUR TURN\nBreak the goal into tasks and assign them, or, if the work is " +
        "done, finish the goal.",
    );
  } else {
    sections.push("YOUR TURN\nThere is no task for you right now. Say so and stop.");
  }

  if (input.note) {
    sections.push(`NOTE\n${input.note}`);
  }

  sections.push(TEAM_PROTOCOL_INSTRUCTIONS);
  return sections.join("\n\n");
}
