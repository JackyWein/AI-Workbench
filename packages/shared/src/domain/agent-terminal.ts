import { z } from "zod";
import { permissionModeSchema } from "./provider.js";

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
