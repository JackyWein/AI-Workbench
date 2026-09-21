import { z } from "zod";
import { usageLimitSchema } from "./usage.js";

export const messageRoleSchema = z.enum(["user", "assistant", "system", "tool"]);
export type MessageRole = z.infer<typeof messageRoleSchema>;

export const messageStatusSchema = z.enum([
  "complete",
  "streaming",
  "cancelled",
  "failed",
]);
export type MessageStatus = z.infer<typeof messageStatusSchema>;

/** A collapsed tool invocation as shown in chat (spec §79). */
export const toolCallRecordSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  summary: z.string().optional(),
  input: z.unknown().optional(),
  output: z.unknown().optional(),
  state: z.enum(["running", "completed", "failed"]),
});
export type ToolCallRecord = z.infer<typeof toolCallRecordSchema>;

export const messageUsageSchema = z.object({
  limits: z.array(usageLimitSchema),
  inputTokens: z.number().nonnegative().optional(),
  outputTokens: z.number().nonnegative().optional(),
  /** Context consumed so far in this provider session, when reported. */
  contextTokens: z.number().nonnegative().optional(),
  /** Size of the model's context window, when known. */
  contextWindow: z.number().positive().optional(),
});
export type MessageUsage = z.infer<typeof messageUsageSchema>;

export const chatMessageSchema = z.object({
  id: z.string().min(1),
  sessionId: z.string().min(1),
  role: messageRoleSchema,
  content: z.string(),
  status: messageStatusSchema,
  providerId: z.string().min(1).nullable(),
  modelId: z.string().min(1).nullable(),
  toolCalls: z.array(toolCallRecordSchema),
  usage: messageUsageSchema.nullable(),
  error: z.string().nullable(),
  createdAt: z.date(),
  updatedAt: z.date(),
});
export type ChatMessage = z.infer<typeof chatMessageSchema>;
