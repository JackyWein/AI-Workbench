import { z } from "zod";
import { workspaceSchema } from "../domain/workspace.js";
import { sessionSchema, sessionStatusSchema } from "../domain/session.js";
import { chatMessageSchema } from "../domain/message.js";
import { aggregatedUsageSchema } from "../domain/usage.js";
import {
  normalizedProviderErrorSchema,
  providerEventSchema,
} from "./provider-events.js";

/**
 * Domain events (spec §106). Subsystems publish here; the main window, the
 * Status Island and StatusAttentionService subscribe to what they need instead
 * of being wired to each other.
 */
export const appEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("workspace.created"), workspace: workspaceSchema }),
  z.object({ type: z.literal("workspace.updated"), workspace: workspaceSchema }),
  z.object({ type: z.literal("workspace.deleted"), workspaceId: z.string() }),

  z.object({ type: z.literal("session.created"), session: sessionSchema }),
  z.object({ type: z.literal("session.updated"), session: sessionSchema }),
  z.object({ type: z.literal("session.deleted"), sessionId: z.string() }),
  z.object({
    type: z.literal("session.status.changed"),
    sessionId: z.string(),
    status: sessionStatusSchema,
  }),

  z.object({
    type: z.literal("message.created"),
    message: chatMessageSchema,
  }),
  z.object({
    type: z.literal("message.delta"),
    sessionId: z.string(),
    messageId: z.string(),
    text: z.string(),
  }),
  z.object({
    type: z.literal("message.updated"),
    message: chatMessageSchema,
  }),
  z.object({
    type: z.literal("message.failed"),
    sessionId: z.string(),
    messageId: z.string(),
    error: normalizedProviderErrorSchema,
  }),

  /** Raw normalized provider event, surfaced only in Developer Mode. */
  z.object({
    type: z.literal("provider.event"),
    sessionId: z.string(),
    providerId: z.string(),
    event: providerEventSchema,
  }),
  z.object({
    type: z.literal("provider.usage.updated"),
    usage: aggregatedUsageSchema,
  }),
]);
export type AppEvent = z.infer<typeof appEventSchema>;
export type AppEventType = AppEvent["type"];
