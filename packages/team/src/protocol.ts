import { z } from "zod";

/**
 * The host-mediated half of the team protocol (spec §43).
 *
 * A provider that speaks MCP reaches the team through `ai-workbench-team-mcp`.
 * A provider that does not still has to be able to take part, so the same
 * operations are offered as structured actions inside its answer, which the
 * orchestrator applies. Both paths end in the same `TeamService` calls, so a
 * team never depends on which providers it happens to contain.
 */

export const teamActionSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("create_task"),
    title: z.string().min(1).max(300),
    description: z.string().max(20_000).optional(),
    assignTo: z.string().min(1).optional(),
    dependsOn: z.array(z.string()).optional(),
    priority: z.number().int().optional(),
  }),
  z.object({
    action: z.literal("delegate_task"),
    taskId: z.string().min(1),
    to: z.string().min(1),
  }),
  z.object({
    action: z.literal("complete_task"),
    taskId: z.string().min(1),
    result: z.string().max(20_000),
    artifacts: z.array(z.string()).optional(),
  }),
  z.object({
    action: z.literal("fail_task"),
    taskId: z.string().min(1),
    error: z.string().max(20_000),
  }),
  z.object({
    action: z.literal("send_message"),
    to: z.string().min(1),
    type: z.enum(["info", "question", "request", "result", "warning", "handoff"]),
    content: z.string().max(100_000),
    taskId: z.string().min(1).optional(),
  }),
  z.object({
    action: z.literal("request_help"),
    question: z.string().min(1).max(20_000),
    taskId: z.string().min(1).optional(),
  }),
  z.object({
    action: z.literal("publish_artifact"),
    name: z.string().min(1).max(300),
    type: z.string().min(1).max(100),
    path: z.string().optional(),
    content: z.string().optional(),
    taskId: z.string().min(1).optional(),
  }),
  z.object({
    action: z.literal("record_decision"),
    title: z.string().min(1).max(300),
    reason: z.string().max(20_000).optional(),
    decision: z.string().min(1).max(20_000),
    relatedTasks: z.array(z.string()).optional(),
  }),
  z.object({
    action: z.literal("update_state"),
    summary: z.string().max(20_000).optional(),
    currentPlan: z.string().max(20_000).optional(),
    importantContext: z.array(z.string()).optional(),
  }),
  z.object({
    action: z.literal("finish_goal"),
    outcome: z.string().min(1).max(20_000),
  }),
]);
export type TeamAction = z.infer<typeof teamActionSchema>;

export interface ParsedActions {
  readonly actions: TeamAction[];
  /** Blocks that looked like actions but were not usable, with the reason. */
  readonly rejected: Array<{ raw: string; reason: string }>;
}

const BLOCK = /```team\s*\n([\s\S]*?)```/g;

/**
 * Reads the action blocks out of an answer. Prose around them is ignored, and
 * a malformed block is reported rather than silently dropped — an agent that
 * gets no feedback repeats the same mistake.
 */
export function parseTeamActions(answer: string): ParsedActions {
  const actions: TeamAction[] = [];
  const rejected: Array<{ raw: string; reason: string }> = [];

  for (const match of answer.matchAll(BLOCK)) {
    const raw = (match[1] ?? "").trim();
    if (raw.length === 0) {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      rejected.push({
        raw,
        reason: error instanceof Error ? error.message : "not valid JSON",
      });
      continue;
    }

    for (const candidate of Array.isArray(parsed) ? parsed : [parsed]) {
      const result = teamActionSchema.safeParse(candidate);
      if (result.success) {
        actions.push(result.data);
      } else {
        rejected.push({
          raw: JSON.stringify(candidate),
          reason: result.error.issues[0]?.message ?? "unknown action",
        });
      }
    }
  }

  return { actions, rejected };
}

/** The protocol as an agent is told about it. */
export const TEAM_PROTOCOL_INSTRUCTIONS = `You are part of a team working on one goal.

You act by writing action blocks in your answer. Each block is fenced with
\`\`\`team and contains one JSON object, or an array of them. Everything outside
the blocks is ignored by the team, so put your reasoning there freely.

Available actions:

  {"action":"create_task","title":"...","description":"...","assignTo":"<agentId>","dependsOn":["<taskId>"],"priority":0}
  {"action":"delegate_task","taskId":"...","to":"<agentId>"}
  {"action":"complete_task","taskId":"...","result":"what you produced","artifacts":["<artifactId>"]}
  {"action":"fail_task","taskId":"...","error":"why it cannot be done"}
  {"action":"send_message","to":"<agentId>|*","type":"info|question|request|result|warning|handoff","content":"..."}
  {"action":"request_help","question":"...","taskId":"..."}
  {"action":"publish_artifact","name":"...","type":"code|diff|doc|test|report|research","content":"...","taskId":"..."}
  {"action":"record_decision","title":"...","reason":"...","decision":"...","relatedTasks":["<taskId>"]}
  {"action":"update_state","summary":"...","currentPlan":"...","importantContext":["..."]}
  {"action":"finish_goal","outcome":"what the team achieved"}

Rules:
- Do not relay work through the user. Talk to your team mates directly.
- Complete or fail the task you were given; do not leave it open.
- Only the lead finishes the goal, and only when the work is actually done.`;
