/**
 * The mock provider's team behaviour (spec §20).
 *
 * MockProvider exists to exercise the application end to end without spending
 * an account, and that has to include Team Mode. So it does here what an
 * instruction-following model does: it reads the prompt the orchestrator built
 * — its own id, the team, its task, its mail — and answers with the action
 * blocks the protocol describes.
 *
 * It decides nothing the orchestrator would otherwise decide. There is no team
 * knowledge here: every id it uses is one the prompt handed it, so a bug in the
 * orchestrator shows up as a broken run rather than being papered over.
 */

interface TeamPrompt {
  readonly agentId: string;
  readonly isLead: boolean;
  /** Null when the prompt does not mark one, which older prompts do not. */
  readonly leadId: string | null;
  readonly taskId: string | null;
  readonly taskTitle: string;
  /** Team mates in the order the prompt listed them, self excluded. */
  readonly others: string[];
  readonly openTasks: Array<{ id: string; status: string; title: string }>;
  readonly goal: string;
}

export function looksLikeTeamPrompt(prompt: string): boolean {
  return prompt.includes("```team") && prompt.includes("GOAL\n");
}

function section(prompt: string, name: string): string {
  const start = prompt.indexOf(`${name}\n`);
  if (start === -1) {
    return "";
  }
  const rest = prompt.slice(start + name.length + 1);
  const end = rest.search(/\n\n[A-Z][A-Z ]+\n/);
  return (end === -1 ? rest : rest.slice(0, end)).trim();
}

export function readTeamPrompt(prompt: string): TeamPrompt {
  const you = section(prompt, "YOU");
  const agentId = you.split(/\s|—/)[0]?.trim() ?? "";
  const isLead = you.includes("You are the lead agent");

  const task = section(prompt, "YOUR TASK");
  const taskMatch = /^(\S+):\s*(.*)$/m.exec(task);

  const mates = section(prompt, "TEAM")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("You are working alone."));
  const leadMatch = /^(\S+).*\(lead\)\s*$/.exec(
    mates.find((line) => line.endsWith("(lead)")) ?? "",
  );
  const others = mates
    .map((line) => line.split(/\s/)[0]?.trim() ?? "")
    .filter((id) => id.length > 0 && id !== agentId);

  const openTasks = section(prompt, "TASKS")
    .split("\n")
    .map((line) => /^(\S+)\s+\[(\w+)\]\s*(.*)$/.exec(line.trim()))
    .filter((match): match is RegExpExecArray => match !== null)
    .map((match) => ({
      id: match[1] ?? "",
      status: match[2] ?? "",
      title: match[3] ?? "",
    }));

  return {
    agentId,
    isLead,
    leadId: leadMatch?.[1] ?? null,
    taskId: taskMatch?.[1] ?? null,
    taskTitle: taskMatch?.[2] ?? "",
    others,
    openTasks,
    goal: section(prompt, "GOAL"),
  };
}

function block(...actions: unknown[]): string {
  return ["```team", JSON.stringify(actions.length === 1 ? actions[0] : actions, null, 2), "```"].join(
    "\n",
  );
}

/**
 * Test markers a goal may carry, so an automated check can drive the paths a
 * cooperative run never takes: `[fail: why]` fails the member's task,
 * `[ask: question]` finishes it and flags a question to a mate. Both live in
 * the adapter (spec §20), never in the team core, and ordinary goals without
 * markers behave exactly as before.
 */
const FAIL_MARKER = /\[fail:\s*([^\]]+)\]/;
const ASK_MARKER = /\[ask:\s*([^\]]+)\]/;

/** The answer a cooperative team member would give for this prompt. */
export function buildTeamReply(prompt: string): string {
  const parsed = readTeamPrompt(prompt);

  // A member with a task does the work and reports back.
  if (parsed.taskId) {
    const fail = FAIL_MARKER.exec(parsed.goal);
    if (fail) {
      return [
        `${parsed.taskTitle || parsed.taskId} cannot be done.`,
        block({
          action: "fail_task",
          taskId: parsed.taskId,
          error: fail[1]?.trim() ?? "The task cannot be done.",
        }),
      ].join("\n\n");
    }

    const actions: unknown[] = [
      {
        action: "publish_artifact",
        name: `${parsed.taskTitle || "result"}.md`,
        type: "report",
        content: `${parsed.agentId} completed: ${parsed.taskTitle}`,
        taskId: parsed.taskId,
      },
      {
        action: "complete_task",
        taskId: parsed.taskId,
        result: `${parsed.agentId} finished "${parsed.taskTitle}".`,
      },
    ];
    const ask = ASK_MARKER.exec(parsed.goal);
    if (ask) {
      const question = ask[1]?.trim() ?? "";
      // A mate that is still around keeps the question unread until someone
      // reads it; the lead reads everything on its next turn, so it is the
      // last resort, not the default.
      const peer = parsed.others.find((id) => id !== parsed.leadId) ?? null;
      actions.push(
        peer
          ? {
              action: "send_message",
              to: peer,
              type: "question",
              content: question,
              taskId: parsed.taskId,
            }
          : { action: "request_help", question, taskId: parsed.taskId },
      );
    }
    return [`Working on ${parsed.taskTitle || parsed.taskId}.`, block(...actions)].join(
      "\n\n",
    );
  }

  if (!parsed.isLead) {
    return "I have no task at the moment.";
  }

  const unfinished = parsed.openTasks.filter(
    (task) => !["completed", "failed", "cancelled"].includes(task.status),
  );
  if (unfinished.length > 0) {
    return `Waiting for ${unfinished.length} task(s) to finish.`;
  }

  // The lead's first turn: break the goal down across the team. With no one
  // else on the team it keeps the work, which is still a real task graph.
  if (parsed.openTasks.length === 0) {
    const workers = parsed.others.length > 0 ? parsed.others : [parsed.agentId];
    const actions: unknown[] = [
      {
        action: "record_decision",
        title: "Work breakdown",
        reason: "The goal needs separable pieces before anyone can start.",
        decision: `Split across ${workers.length} agent(s).`,
      },
      {
        action: "update_state",
        summary: `Planning "${parsed.goal}".`,
        currentPlan: `One task per agent: ${workers.join(", ")}.`,
      },
    ];
    for (const [index, worker] of workers.entries()) {
      actions.push({
        action: "create_task",
        title: `Part ${index + 1} of the goal`,
        description: `${parsed.goal}\n\nHandled by ${worker}.`,
        assignTo: worker,
      });
    }
    return ["Here is the breakdown.", block(...actions)].join("\n\n");
  }

  // Everything is done: the lead closes the goal.
  return [
    "All parts are complete.",
    block({
      action: "finish_goal",
      outcome: `Completed ${parsed.openTasks.length} task(s) for: ${parsed.goal}`,
    }),
  ].join("\n\n");
}
