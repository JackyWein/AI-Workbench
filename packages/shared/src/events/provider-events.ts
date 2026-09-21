import { z } from "zod";
import { messageUsageSchema, toolCallRecordSchema } from "../domain/message.js";

/**
 * Normalized provider events (spec §13). Every adapter translates its native
 * output into these, so the UI never parses provider-specific stdout.
 */
export const providerErrorKindSchema = z.enum([
  "notInstalled",
  "authentication",
  "rateLimit",
  "cancelled",
  "timeout",
  "transport",
  "protocol",
  "provider",
  "unknown",
]);
export type ProviderErrorKind = z.infer<typeof providerErrorKindSchema>;

export const normalizedProviderErrorSchema = z.object({
  kind: providerErrorKindSchema,
  message: z.string(),
  retryable: z.boolean(),
  detail: z.string().optional(),
});
export type NormalizedProviderError = z.infer<
  typeof normalizedProviderErrorSchema
>;

export const providerEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text_delta"), text: z.string() }),
  z.object({ type: z.literal("message"), text: z.string() }),
  z.object({
    type: z.literal("status"),
    status: z.string(),
    detail: z.string().optional(),
  }),
  z.object({ type: z.literal("tool_call"), toolCall: toolCallRecordSchema }),
  z.object({ type: z.literal("tool_result"), toolCall: toolCallRecordSchema }),
  z.object({ type: z.literal("usage"), usage: messageUsageSchema }),
  z.object({ type: z.literal("warning"), message: z.string() }),
  z.object({ type: z.literal("error"), error: normalizedProviderErrorSchema }),
  z.object({
    type: z.literal("session"),
    providerSessionId: z.string(),
    resumable: z.boolean(),
  }),
  z.object({
    type: z.literal("completed"),
    reason: z.enum(["finished", "cancelled", "failed"]),
  }),
]);
export type ProviderEvent = z.infer<typeof providerEventSchema>;
