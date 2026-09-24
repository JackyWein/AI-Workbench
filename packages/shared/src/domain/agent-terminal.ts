import { z } from "zod";
import { permissionModeSchema } from "./provider.js";
import { usageLimitSchema } from "./usage.js";

/**
 * A terminal agent: a provider's own interactive interface running in a real
 * terminal inside a workspace (spec §26). The tool keeps its full native
 * experience — its own prompts, approvals and rendering — while the
 * application places it next to the others, keeps it running when it is not
 * visible, and lets agents work together.
 *
 * The definition is persisted so a workspace reopens with its agents in
 * place; the process is not, so after a restart a tile is "stopped" until the
 * person starts it again. Nothing is launched without being asked.
 */
export const agentTerminalPurposeSchema = z.enum([
  /** A provider's interactive interface. */
  "agent",
  /** A provider's own sign-in for one of its accounts; removed when it ends. */
  "login",
  /** A provider's own one-time setup (see ProviderIntegration); removed when it ends. */
  "setup",
  /** A plain shell in the workspace. */
  "shell",
]);
export type AgentTerminalPurpose = z.infer<typeof agentTerminalPurposeSchema>;

export const agentTerminalStateSchema = z.enum([
  /** The process is running. */
  "running",
  /** The process ended on its own; `exitCode` says how. */
  "exited",
  /** Not started in this run of the application, or stopped by the person. */
  "stopped",
  /** It could not be started; `detail` says why. */
  "failed",
]);
export type AgentTerminalState = z.infer<typeof agentTerminalStateSchema>;

/** Token counts a tool reported for one of its sessions. */
export const terminalTokensSchema = z.object({
  input: z.number().nonnegative(),
  output: z.number().nonnegative(),
  /** Input served from the provider's prompt cache, when it tells them apart. */
  cacheRead: z.number().nonnegative().optional(),
  /** Input written to the provider's prompt cache. */
  cacheWrite: z.number().nonnegative().optional(),
  /** Output spent on reasoning, when reported separately. */
  reasoning: z.number().nonnegative().optional(),
});
export type TerminalTokens = z.infer<typeof terminalTokensSchema>;

/**
 * What a terminal agent's tool reported about its own session (spec §55, §56).
 *
 * Every field is optional because every tool says something different; the
 * provider package reads the tool's own channel — a status line hook, a
 * session log or the tool's local API — and fills in only what it was told.
 * Nothing here is derived from the terminal's screen.
 */
export const terminalMetricsSchema = z.object({
  /** Where the numbers came from, in words the person understands. */
  source: z.string().min(1),
  /** The tool's own id for the session, when it said. */
  providerSessionId: z.string().min(1).optional(),
  /** The model the session is running on, as the tool names it. */
  model: z.string().min(1).optional(),
  /** Time the tool counts the session as running, when it tracks it. */
  activeMs: z.number().nonnegative().optional(),
  /** Tokens spent over the whole session. */
  tokens: terminalTokensSchema.optional(),
  /** Cost of the session in US dollars. */
  costUsd: z.number().nonnegative().optional(),
  /** True when the tool computes the cost itself from list prices. */
  costEstimated: z.boolean().optional(),
  /** How full the context window is right now. */
  context: z
    .object({
      usedTokens: z.number().nonnegative(),
      windowTokens: z.number().positive().optional(),
    })
    .optional(),
  /** Account limits the tool reported alongside, e.g. a 5-hour window. */
  limits: z.array(usageLimitSchema).default([]),
  updatedAt: z.date(),
});
export type TerminalMetrics = z.infer<typeof terminalMetricsSchema>;

/** One choice of a question a tool put to the person. */
export const terminalAttentionChoiceSchema = z.object({
  id: z.string().min(1).max(200),
  label: z.string().min(1).max(200),
  hint: z.string().max(200).optional(),
});
export type TerminalAttentionChoice = z.infer<typeof terminalAttentionChoiceSchema>;

/**
 * Something a terminal agent's tool is waiting on the person for (spec §99),
 * as the tool itself reported it through its own documented channel — or, for
 * a tool that reports nothing, as its own dialog reads on its screen.
 *
 * The tool's own prompt stays in its terminal and stays answerable there;
 * this only lets the application show that it waits, and — where the tool
 * accepts it — take the answer somewhere else, such as the island.
 */
export const terminalAttentionSchema = z.object({
  /** Identifies this one request; a new request gets a new id. */
  id: z.string().min(1).max(200),
  /**
   * "permission": it asks to use one of its tools. "question": it asks the
   * person something and offers choices.
   */
  kind: z.enum(["permission", "question"]),
  /** The tool it wants to use, as the tool names it (e.g. "Bash"). */
  tool: z.string().min(1).max(120).optional(),
  /** What it wants, in one line: the command, the file, the question. */
  summary: z.string().max(500),
  /** What the request is about beyond that line, e.g. the command a question asks to run. */
  context: z.string().max(500).optional(),
  /** The choices of a question; empty for a permission. */
  choices: z.array(terminalAttentionChoiceSchema).max(9).default([]),
  /**
   * True when the tool takes the answer from outside its terminal. When
   * false, the only place to answer is the terminal itself.
   */
  answerable: z.boolean(),
  /** When the tool started waiting. */
  since: z.date(),
});
export type TerminalAttention = z.infer<typeof terminalAttentionSchema>;

/**
 * What a terminal agent's tool says it is doing: working on a turn, or idle at
 * its prompt waiting for the person. Only what the tool reported through its
 * own channel; a tool that says nothing has no activity at all, and a running
 * process alone is not taken to mean it works.
 */
export const terminalActivitySchema = z.object({
  state: z.enum(["working", "idle"]),
  /** When it started working, or became idle. */
  since: z.date(),
});
export type TerminalActivity = z.infer<typeof terminalActivitySchema>;

/** An answer to a waiting request: a permission granted or refused, or a choice. */
export const terminalAttentionResponseSchema = z.union([
  z.object({ decision: z.enum(["allow", "deny"]) }),
  z.object({ choice: z.string().min(1).max(200) }),
]);
export type TerminalAttentionResponse = z.infer<typeof terminalAttentionResponseSchema>;

export const agentTerminalSchema = z.object({
  id: z.string().min(1),
  workspaceId: z.string().min(1),
  purpose: agentTerminalPurposeSchema,
  /** The provider entry (tool and account); null for a plain shell. */
  providerId: z.string().min(1).nullable(),
  label: z.string().min(1).max(120),
  modelId: z.string().min(1).nullable(),
  reasoningEffort: z.string().min(1).nullable(),
  permissionMode: permissionModeSchema.nullable(),
  workingDirectory: z.string().min(1),
  /** The live terminal, while there is one. */
  terminalId: z.string().min(1).nullable(),
  state: agentTerminalStateSchema,
  exitCode: z.number().int().nullable(),
  detail: z.string().optional(),
  startedAt: z.date().nullable(),
  /** The last numbers the tool reported for this run; null until it says any. */
  metrics: terminalMetricsSchema.nullable().default(null),
  /** What the tool waits on the person for right now; null when nothing. */
  attention: terminalAttentionSchema.nullable().default(null),
  /** Working or idle, as the tool reported; null when it does not say. */
  activity: terminalActivitySchema.nullable().default(null),
  createdAt: z.date(),
});
export type AgentTerminal = z.infer<typeof agentTerminalSchema>;

export const launchAgentTerminalInputSchema = z.object({
  workspaceId: z.string().min(1),
  purpose: z.enum(["agent", "shell"]).default("agent"),
  providerId: z.string().min(1).optional(),
  label: z.string().trim().min(1).max(120).optional(),
  modelId: z.string().min(1).optional(),
  reasoningEffort: z.string().min(1).optional(),
  permissionMode: permissionModeSchema.optional(),
  /** Relative to the workspace, or inside it; defaults to its root. */
  workingDirectory: z.string().min(1).optional(),
  cols: z.number().int().positive().max(1000).optional(),
  rows: z.number().int().positive().max(1000).optional(),
});
export type LaunchAgentTerminalInput = z.input<typeof launchAgentTerminalInputSchema>;

export const updateAgentTerminalInputSchema = z.object({
  id: z.string().min(1),
  label: z.string().trim().min(1).max(120).optional(),
  modelId: z.string().min(1).nullable().optional(),
  reasoningEffort: z.string().min(1).nullable().optional(),
  permissionMode: permissionModeSchema.nullable().optional(),
});
export type UpdateAgentTerminalInput = z.infer<typeof updateAgentTerminalInputSchema>;
