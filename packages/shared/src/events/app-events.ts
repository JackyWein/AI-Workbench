import { z } from "zod";
import { workspaceSchema } from "../domain/workspace.js";
import { sessionSchema, sessionStatusSchema } from "../domain/session.js";
import { chatMessageSchema } from "../domain/message.js";
import { aggregatedUsageSchema } from "../domain/usage.js";
import { providerSummarySchema } from "../domain/provider.js";
import { agentTerminalSchema } from "../domain/agent-terminal.js";
import { teamEventSchema } from "../domain/team.js";
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
  /**
   * A provider learned something on its own — its models, sign-in or limits
   * read in the background — so the UI can update without polling.
   */
  z.object({
    type: z.literal("provider.updated"),
    summary: providerSummarySchema,
  }),
  /** Provider entries were added or removed, e.g. an account was connected. */
  z.object({ type: z.literal("provider.list.changed") }),

  z.object({ type: z.literal("agentTerminal.changed"), terminal: agentTerminalSchema }),
  z.object({
    type: z.literal("agentTerminal.removed"),
    id: z.string(),
    workspaceId: z.string(),
  }),

  // Team events reach the UI on the same channel as everything else, so the
  // renderer has one stream to follow (spec §50).
  z.object({ type: z.literal("team.event"), event: teamEventSchema }),
]);
export type AppEvent = z.infer<typeof appEventSchema>;
export type AppEventType = AppEvent["type"];
