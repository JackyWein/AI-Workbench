import { agentInstructions, type AgentDefinition, type MessageAttachment, type TeamMessage, type TeamTask } from "@ai-workbench/shared";
import { TEAM_PROTOCOL_INSTRUCTIONS } from "./protocol.js";
import type { TeamService } from "./service.js";

/**
 * What an agent is given for one turn.
 *
 * Deliberately bounded: the shared state, its own task, its unread mail and the
 * protocol — never the other agents' conversations (spec §47). Every section
 * is capped so a long-lived run cannot grow its prompt without bound and OOM
 * the provider call: only the newest entries travel, each truncated, with a
 * total cap on top.
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
    sections.push(`WHAT HAS HAPPENED\n${truncate(state.summary, 4_000)}`);
  }
  if (state.currentPlan) {
    sections.push(`CURRENT PLAN\n${truncate(state.currentPlan, 4_000)}`);
  }
  if (state.importantContext.length > 0) {
    const context = state.importantContext.slice(-20).map((entry) => truncate(entry, 1_000));
    sections.push(`IMPORTANT CONTEXT\n${context.join("\n")}`);
  }
  if (state.tasks.length > 0) {
    sections.push(`TASKS\n${state.tasks.slice(-50).join("\n").slice(0, 8_000)}`);
  }
  if (state.decisions.length > 0) {
    const decisions = state.decisions.slice(-20).map((entry) => truncate(entry, 800));
    sections.push(`DECISIONS\n${decisions.join("\n")}`);
  }
  if (state.artifacts.length > 0) {
    sections.push(`ARTIFACTS\n${state.artifacts.slice(-20).join("\n").slice(0, 4_000)}`);
  }

  if (inbox.length > 0) {
    const mail = inbox.slice(-20).map((message) =>
      truncate(
        `from ${message.from} (${message.type}): ${message.content}${describeAttachments(message.attachments)}`,
        2_000,
      ),
    );
    sections.push(`MESSAGES FOR YOU\n${mail.join("\n")}`);
  }

  if (task) {
    sections.push(
      `YOUR TASK\n${task.id}: ${truncate(task.title, 300)}` +
        (task.description ? `\n${truncate(task.description, 2_000)}` : "") +
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
    sections.push(`NOTE\n${truncate(input.note, 2_000)}`);
  }

  // Total cap on the context (protocol stays intact): a run that accumulated
  // months of history still sends a bounded prompt.
  const body = sections.join("\n\n");
  const capped = body.length > 24_000 ? `… earlier context trimmed …\n${body.slice(body.length - 24_000)}` : body;
  return `${capped}\n\n${TEAM_PROTOCOL_INSTRUCTIONS}`;
}

/** Truncates to max characters, keeping the tail (the newest detail). */
function truncate(text: string, max: number): string {
  if (text.length <= max) {
    return text;
  }
  return `… ${text.slice(text.length - max)}`;
}

/**
 * Files arriving with a team message, as the agent reads them: the kept paths
 * on this computer, so a provider that takes no attachment flag can still open
 * them. Providers with a flag of their own get the same files via
 * `AgentMessage.attachments` (see the orchestrator).
 */
function describeAttachments(attachments: readonly MessageAttachment[] | undefined): string {
  if (!attachments || attachments.length === 0) {
    return "";
  }
  const lines = attachments.map((entry) => `- ${entry.path} (${entry.kind}, ${entry.name})`);
  return `\nAttached files (read them from these paths):\n${lines.join("\n")}`;
}

/** Every file attached to unread mail, deduplicated by path, for provider forwarding. */
export function inboxAttachments(inbox: readonly TeamMessage[]): MessageAttachment[] {
  const seen = new Set<string>();
  const collected: MessageAttachment[] = [];
  for (const message of inbox) {
    for (const attachment of message.attachments ?? []) {
      if (!seen.has(attachment.path)) {
        seen.add(attachment.path);
        collected.push(attachment);
      }
    }
  }
  return collected;
}
