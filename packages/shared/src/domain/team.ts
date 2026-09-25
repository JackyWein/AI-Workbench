import { z } from "zod";
import { messageAttachmentSchema } from "./message.js";

/**
 * The team model (spec §40–§53).
 *
 * Nothing here names a provider: an agent points at a provider id the registry
 * resolves, so a team of three Claudes and a team of Claude, Codex and a local
 * model are the same structure (spec §39).
 */

/** One provider-backed participant in a team (spec §40). */
export const agentDefinitionSchema = z.object({
  id: z.string().min(1),
  displayName: z.string().min(1).max(200),
  providerId: z.string().min(1),
  modelId: z.string().min(1).optional(),
  /** Free text, handed to the agent as part of its instructions. */
  role: z.string().max(2000).default(""),
  workingDirectory: z.string().min(1),
  skills: z.array(z.string()).default([]),
  plugins: z.array(z.string()).default([]),
  mcpServers: z.array(z.string()).default([]),
  settings: z.record(z.unknown()).default({}),
});
export type AgentDefinition = z.infer<typeof agentDefinitionSchema>;
export type AgentDefinitionInput = z.input<typeof agentDefinitionSchema>;

/** Characters of a member's own instructions that reach its prompt. */
export const AGENT_INSTRUCTIONS_LIMIT = 8_000;

/**
 * A member's own instructions — how it works in its role, e.g. a reviewer's
 * checklist — kept in its settings. Empty when it has none.
 */
export function agentInstructions(agent: Pick<AgentDefinition, "settings">): string {
  const value = agent.settings["instructions"];
  return typeof value === "string" ? value.trim().slice(0, AGENT_INSTRUCTIONS_LIMIT) : "";
}

/**
 * A member's reasoning effort — how hard its tool should think — kept in its
 * settings next to its instructions. Empty when it uses the tool's default.
 * Stored in settings (not a dedicated column) like `agentInstructions`, so
 * existing teams and IPC payloads keep working without a migration.
 */
export function agentReasoningEffort(agent: Pick<AgentDefinition, "settings">): string {
  const value = agent.settings["reasoningEffort"];
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Bounds on an autonomous run (spec §51). Autonomy without limits is how a
 * team burns an account overnight, so every run carries them.
 */
export const teamRunConfigSchema = z.object({
  maxAgentCalls: z.number().int().positive().max(1000).default(30),
  maxTasks: z.number().int().positive().max(1000).default(50),
  maxTaskDepth: z.number().int().positive().max(64).default(8),
  maxRuntimeMinutes: z.number().int().positive().max(1440).default(240),
  maxFailures: z.number().int().positive().max(1000).default(10),
  maxConcurrentAgents: z.number().int().positive().max(16).default(3),
  maxMessages: z.number().int().positive().max(10_000).default(200),
  maxDelegationsPerTask: z.number().int().positive().max(64).default(4),
  /**
   * How long one agent turn may go without producing anything, in seconds.
   * A turn that streams text or runs tools resets it (see the orchestrator),
   * so this is the silence budget, not the time budget of the work. The
   * default matches the command line adapters' own silence limit: a slower
   * model is a reason to wait, not to be cut off.
   */
  agentTurnSilenceSeconds: z.number().int().positive().max(3600).default(900),
});
export type TeamRunConfig = z.infer<typeof teamRunConfigSchema>;

/**
 * Limits a team saved before 0.0.7 carry the defaults of that time — an hour
 * per run and ten quiet minutes per turn — which nobody chose: the
 * application never asked. They cut real work short (a builder writing a
 * site takes longer), so a new run gets today's defaults in their place.
 * Any other value was set on purpose and stays.
 */
export function upgradeRunLimits(limits: TeamRunConfig): TeamRunConfig {
  return {
    ...limits,
    maxRuntimeMinutes: limits.maxRuntimeMinutes === 60 ? 240 : limits.maxRuntimeMinutes,
    agentTurnSilenceSeconds: limits.agentTurnSilenceSeconds === 600 ? 900 : limits.agentTurnSilenceSeconds,
  };
}

export const teamSettingsSchema = z.object({
  /** Isolated run branches; finished work is integrated in the lead's worktree. */
  separateWorktrees: z.boolean().default(false),
  limits: teamRunConfigSchema.default({}),
  /** Extra instructions handed to every agent of this team. */
  instructions: z.string().max(10_000).default(""),
  /**
   * May this team work outside the workspace it belongs to? Off by default:
   * a team writes where its folder says, and going elsewhere is a decision a
   * person makes, never a side effect (spec §19, §25).
   */
  allowOutsideWorkspace: z.boolean().default(false),
  /**
   * Where the team works. Null means "the workspace's folder". Set only with
   * `allowOutsideWorkspace` when it points outside that workspace.
   */
  workingDirectory: z.string().min(1).nullable().default(null),
});
export type TeamSettings = z.infer<typeof teamSettingsSchema>;

export const teamDefinitionSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1).max(200),
  workspaceId: z.string().min(1),
  /** The agent that breaks the goal down and decides when it is done (spec §52). */
  leadAgentId: z.string().min(1).nullable().default(null),
  agents: z.array(agentDefinitionSchema).default([]),
  settings: teamSettingsSchema.default({}),
  createdAt: z.date(),
  updatedAt: z.date(),
});
export type TeamDefinition = z.infer<typeof teamDefinitionSchema>;

export const createTeamInputSchema = z.object({
  workspaceId: z.string().min(1),
  name: z.string().min(1).max(200),
  agents: z.array(agentDefinitionSchema.omit({ id: true }).partial({ workingDirectory: true })),
  leadAgentIndex: z.number().int().nonnegative().optional(),
  settings: teamSettingsSchema.partial().optional(),
});
export type CreateTeamInput = z.infer<typeof createTeamInputSchema>;
/** Before defaults are applied, which is what a caller writes. */
export type CreateTeamInputData = z.input<typeof createTeamInputSchema>;

/**
 * Changes to a team. An agent that carries the id of one of the team's
 * agents is that agent, edited; one without an id joins the team; an agent
 * left out leaves it. Where agents work is not theirs to set: a run works in
 * the workspace it is started from, or in the team's own folder.
 */
export const updateTeamInputSchema = z.object({
  separateWorktrees: z.boolean().optional(),
  teamId: z.string().min(1),
  name: z.string().min(1).max(200).optional(),
  agents: z
    .array(agentDefinitionSchema.omit({ workingDirectory: true }).partial({ id: true }))
    .min(1)
    .optional(),
  /** Index into `agents` (or the current agents) of the lead. */
  leadAgentIndex: z.number().int().nonnegative().optional(),
  instructions: z.string().max(10_000).optional(),
});
export type UpdateTeamInput = z.infer<typeof updateTeamInputSchema>;
export type UpdateTeamInputData = z.input<typeof updateTeamInputSchema>;

/** Where a task stands in the graph (spec §45). */
export const teamTaskStatusSchema = z.enum([
  "pending",
  "ready",
  "claimed",
  "running",
  "blocked",
  "completed",
  "failed",
  "cancelled",
]);
export type TeamTaskStatus = z.infer<typeof teamTaskStatusSchema>;

export const teamTaskSchema = z.object({
  id: z.string().min(1),
  runId: z.string().min(1),
  title: z.string().min(1).max(300),
  description: z.string().max(20_000).default(""),
  status: teamTaskStatusSchema,
  createdBy: z.string().min(1),
  assignedTo: z.string().min(1).nullable().default(null),
  parentTaskId: z.string().min(1).nullable().default(null),
  dependencies: z.array(z.string()).default([]),
  priority: z.number().int().default(0),
  /** How deep in the delegation chain this task sits (spec §51). */
  depth: z.number().int().nonnegative().default(0),
  /** How often this task has been handed on, which bounds ping-pong. */
  delegations: z.number().int().nonnegative().default(0),
  result: z.string().nullable().default(null),
  artifacts: z.array(z.string()).default([]),
  error: z.string().nullable().default(null),
  createdAt: z.date(),
  startedAt: z.date().nullable().default(null),
  completedAt: z.date().nullable().default(null),
});
export type TeamTask = z.infer<typeof teamTaskSchema>;

/** A message between agents (spec §46). */
export const teamMessageTypeSchema = z.enum([
  "info",
  "question",
  "request",
  "result",
  "warning",
  "handoff",
]);
export type TeamMessageType = z.infer<typeof teamMessageTypeSchema>;

export const teamMessageSchema = z.object({
  id: z.string().min(1),
  runId: z.string().min(1),
  from: z.string().min(1),
  /** An agent id, or "*" for everyone on the team. */
  to: z.string().min(1),
  type: teamMessageTypeSchema,
  content: z.string().max(100_000),
  taskId: z.string().min(1).nullable().default(null),
  /** Files the person sent with this message, kept like a solo chat. */
  attachments: z.array(messageAttachmentSchema).default([]),
  /** Set once the recipient has read it through the team interface. */
  readAt: z.date().nullable().default(null),
  timestamp: z.date(),
});
export type TeamMessage = z.infer<typeof teamMessageSchema>;

/**
 * What every agent may read instead of the whole conversation (spec §47).
 * Passing chat histories around is what makes multi-agent setups expensive and
 * incoherent; this is the shared, bounded alternative.
 */
export const sharedTeamStateSchema = z.object({
  goal: z.string().default(""),
  summary: z.string().default(""),
  currentPlan: z.string().nullable().default(null),
  importantContext: z.array(z.string()).default([]),
});
export type SharedTeamState = z.infer<typeof sharedTeamStateSchema>;

/** A decision worth keeping, with its reason (spec §48). */
export const teamDecisionSchema = z.object({
  id: z.string().min(1),
  runId: z.string().min(1),
  author: z.string().min(1),
  title: z.string().min(1).max(300),
  reason: z.string().max(20_000).default(""),
  decision: z.string().max(20_000),
  relatedTasks: z.array(z.string()).default([]),
  timestamp: z.date(),
});
export type TeamDecision = z.infer<typeof teamDecisionSchema>;

/** Something an agent produced (spec §49). */
export const teamArtifactSchema = z.object({
  id: z.string().min(1),
  runId: z.string().min(1),
  name: z.string().min(1).max(300),
  type: z.string().min(1).max(100),
  /** Relative to the agent's working directory, when it is a file. */
  path: z.string().nullable().default(null),
  content: z.string().nullable().default(null),
  createdBy: z.string().min(1),
  taskId: z.string().min(1).nullable().default(null),
  metadata: z.record(z.unknown()).default({}),
  timestamp: z.date(),
});
export type TeamArtifact = z.infer<typeof teamArtifactSchema>;

/** Characters of a member's turn output that are kept. */
export const TEAM_TURN_OUTPUT_LIMIT = 200_000;
/** Steps of a member's turn that are kept. */
export const TEAM_TURN_STEP_LIMIT = 400;

/** One thing a member did during a turn, in its tool's own words. */
export const teamTurnStepSchema = z.object({
  at: z.date(),
  detail: z.string().max(300),
});
export type TeamTurnStep = z.infer<typeof teamTurnStepSchema>;

/**
 * One turn of one member (spec §50): everything it wrote, in its own words,
 * and every step its tool reported, from start to end. This is the member's
 * own story — what the task graph and the mailbox only summarise.
 */
export const teamTurnSchema = z.object({
  id: z.string().min(1),
  runId: z.string().min(1),
  agentId: z.string().min(1),
  /** The task it worked on; null for a lead's planning turn. */
  taskId: z.string().min(1).nullable(),
  status: z.enum(["running", "completed", "failed"]),
  /** What it wrote, as it wrote it; the start is trimmed past the limit. */
  output: z.string().max(TEAM_TURN_OUTPUT_LIMIT + 200),
  /** Its tool's steps, oldest first; the oldest go past the limit. */
  steps: z.array(teamTurnStepSchema).max(TEAM_TURN_STEP_LIMIT),
  error: z.string().max(2000).nullable(),
  startedAt: z.date(),
  finishedAt: z.date().nullable(),
});
export type TeamTurn = z.infer<typeof teamTurnSchema>;

export const teamRunStatusSchema = z.enum([
  "pending",
  "running",
  "paused",
  "completed",
  "failed",
  "cancelled",
]);
export type TeamRunStatus = z.infer<typeof teamRunStatusSchema>;

/** Why a run stopped, when it stopped for a reason worth naming. */
export const teamRunStopReasonSchema = z.enum([
  "goalFinished",
  "noWorkLeft",
  "limitReached",
  "tooManyFailures",
  "cancelled",
  "paused",
  /**
   * The application stopped while the run was going — a crash, a kill, a
   * restart. The run is paused where it was and waits to be resumed.
   */
  "interrupted",
]);
export type TeamRunStopReason = z.infer<typeof teamRunStopReasonSchema>;

export const teamRunSchema = z.object({
  id: z.string().min(1),
  teamId: z.string().min(1),
  workspaceId: z.string().min(1),
  /**
   * The session the run belongs to. A session only ever shows and continues
   * its own runs, so a new session starts its team without another one's
   * history. Null for runs started outside a session (the Teams screen).
   */
  sessionId: z.string().nullable().default(null),
  goal: z.string().min(1).max(20_000),
  status: teamRunStatusSchema,
  stopReason: teamRunStopReasonSchema.nullable().default(null),
  /** Set by the lead when it declares the goal reached (spec §52). */
  outcome: z.string().nullable().default(null),
  sharedState: sharedTeamStateSchema,
  limits: teamRunConfigSchema,
  /** Counters the orchestrator checks the limits against. */
  agentCalls: z.number().int().nonnegative().default(0),
  failures: z.number().int().nonnegative().default(0),
  messageCount: z.number().int().nonnegative().default(0),
  createdAt: z.date(),
  startedAt: z.date().nullable().default(null),
  finishedAt: z.date().nullable().default(null),
});
export type TeamRun = z.infer<typeof teamRunSchema>;

/** Live team events (spec §50), consumed by the UI and the Status Island. */
export const teamEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("TEAM_STARTED"), runId: z.string(), goal: z.string() }),
  z.object({
    type: z.literal("TEAM_FINISHED"),
    runId: z.string(),
    status: teamRunStatusSchema,
    stopReason: teamRunStopReasonSchema.nullable(),
    outcome: z.string().nullable(),
  }),
  z.object({ type: z.literal("AGENT_STARTED"), runId: z.string(), agentId: z.string() }),
  z.object({ type: z.literal("AGENT_STOPPED"), runId: z.string(), agentId: z.string() }),
  z.object({
    type: z.literal("AGENT_FAILED"),
    runId: z.string(),
    agentId: z.string(),
    error: z.string(),
  }),
  /**
   * An agent is still working. Emitted while a turn streams or runs tools so
   * a long turn never looks like a frozen run (spec §50). `detail` is the
   * tool's own wording, truncated, never invented.
   */
  z.object({
    type: z.literal("AGENT_PROGRESS"),
    runId: z.string(),
    agentId: z.string(),
    detail: z.string().max(200).default(""),
  }),
  z.object({ type: z.literal("TASK_CREATED"), runId: z.string(), task: teamTaskSchema }),
  z.object({
    type: z.literal("TASK_ASSIGNED"),
    runId: z.string(),
    taskId: z.string(),
    agentId: z.string(),
  }),
  z.object({ type: z.literal("TASK_STARTED"), runId: z.string(), taskId: z.string() }),
  z.object({
    type: z.literal("TASK_BLOCKED"),
    runId: z.string(),
    taskId: z.string(),
    waitingFor: z.array(z.string()),
  }),
  z.object({
    type: z.literal("TASK_COMPLETED"),
    runId: z.string(),
    taskId: z.string(),
    result: z.string().nullable(),
  }),
  z.object({
    type: z.literal("TASK_FAILED"),
    runId: z.string(),
    taskId: z.string(),
    error: z.string(),
  }),
  z.object({ type: z.literal("MESSAGE_SENT"), runId: z.string(), message: teamMessageSchema }),
  z.object({
    type: z.literal("ARTIFACT_PUBLISHED"),
    runId: z.string(),
    artifact: teamArtifactSchema,
  }),
  z.object({
    type: z.literal("DECISION_RECORDED"),
    runId: z.string(),
    decision: teamDecisionSchema,
  }),
  z.object({
    type: z.literal("HELP_REQUESTED"),
    runId: z.string(),
    agentId: z.string(),
    taskId: z.string().nullable(),
    question: z.string(),
  }),
  z.object({
    type: z.literal("USER_ATTENTION_REQUIRED"),
    runId: z.string(),
    reason: z.string(),
  }),
]);
export type TeamEvent = z.infer<typeof teamEventSchema>;

/** Everything one run consists of, which is also what recovery restores. */
export const teamRunSnapshotSchema = z.object({
  run: teamRunSchema,
  tasks: z.array(teamTaskSchema),
  messages: z.array(teamMessageSchema),
  decisions: z.array(teamDecisionSchema),
  artifacts: z.array(teamArtifactSchema),
  /** Every member's turns, oldest first; runs from before 0.0.7 have none. */
  turns: z.array(teamTurnSchema).default([]),
});
export type TeamRunSnapshot = z.infer<typeof teamRunSnapshotSchema>;
