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

/**
 * A file sent along with a message. The path is on this computer; how the
 * provider receives it (a flag of its own, a reference in the prompt) is the
 * provider's business, and one that cannot take files is never sent any.
 */
export const messageAttachmentSchema = z.object({
  path: z.string().min(1).max(4096),
  name: z.string().min(1).max(260),
  kind: z.enum(["image", "file"]),
  size: z.number().int().nonnegative().optional(),
});
export type MessageAttachment = z.infer<typeof messageAttachmentSchema>;

/** The largest single file a message carries. */
export const MAX_ATTACHMENT_BYTES = 50 * 1024 * 1024;

/** Picture formats the tools that take images all read. */
const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp"]);

/** "image" for a picture the tools read as one, otherwise "file". */
export function attachmentKind(name: string): MessageAttachment["kind"] {
  const dot = name.lastIndexOf(".");
  const extension = dot === -1 ? "" : name.slice(dot + 1).toLowerCase();
  return IMAGE_EXTENSIONS.has(extension) ? "image" : "file";
}

export const messageUsageSchema = z.object({
  limits: z.array(usageLimitSchema),
  inputTokens: z.number().nonnegative().optional(),
  outputTokens: z.number().nonnegative().optional(),
  /** Input served from the provider's prompt cache. */
  cacheReadTokens: z.number().nonnegative().optional(),
  /** Input written to the provider's prompt cache. */
  cacheWriteTokens: z.number().nonnegative().optional(),
  /** Cost of the turn in US dollars, as the tool reported it. */
  costUsd: z.number().nonnegative().optional(),
  /** How long the turn took, as the tool measured it. */
  durationMs: z.number().nonnegative().optional(),
  /** Context consumed so far in this provider session, when reported. */
  contextTokens: z.number().nonnegative().optional(),
  /** Size of the model's context window, when known. */
  contextWindow: z.number().positive().optional(),
});
export type MessageUsage = z.infer<typeof messageUsageSchema>;

/** One account of a tool, as a notice in the chat names it. */
const noticeAccountSchema = z.object({
  providerId: z.string().min(1),
  label: z.string().min(1),
});

/**
 * What happened when an account reached its limit, kept as a line in the
 * chat. `switched`: the turn went on on `to`. `offered`: the person decides
 * whether to go on on `to`. `stopped`: switching is off, or every other
 * account of the tool is at its limit too.
 */
export const accountNoticeSchema = z.object({
  kind: z.literal("account"),
  state: z.enum(["switched", "offered", "stopped"]),
  /** The tool's name, e.g. "Claude Code". */
  tool: z.string().min(1),
  from: noticeAccountSchema,
  to: noticeAccountSchema.nullable(),
  /** The tool's own words about the limit. */
  reason: z.string(),
  /** When the limit ends, if the tool said; for `stopped`, the earliest. */
  resetsAt: z.coerce.date().nullable(),
  /**
   * How the conversation went along: the tool's own files moved into the
   * other account's home, or the application handed it over in the first
   * message. Null until it went along.
   */
  carried: z.enum(["native", "handover"]).nullable(),
});
export type AccountNotice = z.infer<typeof accountNoticeSchema>;

export const chatMessageSchema = z.object({
  id: z.string().min(1),
  sessionId: z.string().min(1),
  role: messageRoleSchema,
  content: z.string(),
  status: messageStatusSchema,
  providerId: z.string().min(1).nullable(),
  modelId: z.string().min(1).nullable(),
  toolCalls: z.array(toolCallRecordSchema),
  /** Files the person sent with this message. */
  attachments: z.array(messageAttachmentSchema).default([]),
  usage: messageUsageSchema.nullable(),
  error: z.string().nullable(),
  /** Set on the application's own lines, like an account switch. */
  notice: accountNoticeSchema.optional(),
  createdAt: z.date(),
  updatedAt: z.date(),
});
export type ChatMessage = z.infer<typeof chatMessageSchema>;
