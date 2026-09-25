import { z } from "zod";
import { permissionModeSchema } from "./provider.js";

export const scheduleTargetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("solo"), providerId: z.string().min(1), modelId: z.string().optional(), reasoningEffort: z.string().optional() }),
  z.object({ kind: z.literal("team"), teamId: z.string().min(1) }),
]);
export const scheduleContentSchema = z.object({
  name: z.string().trim().min(1).max(200),
  workspaceId: z.string().min(1),
  target: scheduleTargetSchema,
  prompt: z.string().trim().min(1).max(50_000),
  cron: z.string().trim().min(1).max(150),
  timezone: z.string().min(1).max(100),
  catchUp: z.enum(["skip", "once"]).default("skip"),
  enabled: z.boolean().default(true),
  permissionMode: permissionModeSchema,
  budget: z.object({
    maxTurns: z.number().int().min(1).max(1000).default(1),
    maxTokens: z.number().int().positive().nullable().default(null),
    maxRuntimeSeconds: z.number().int().min(1).max(86_400).default(600),
  }).default({}),
});
export const scheduleSchema = scheduleContentSchema.extend({
  id: z.string(), lastRunAt: z.date().nullable(), nextRunAt: z.date().nullable(), createdAt: z.date(), updatedAt: z.date(),
});
export const scheduleRunSchema = z.object({
  id: z.string(), scheduleId: z.string(), sessionId: z.string().nullable(), teamRunId: z.string().nullable(),
  dueAt: z.date(), startedAt: z.date(), finishedAt: z.date().nullable(),
  status: z.enum(["running", "completed", "failed", "budget", "interrupted", "skipped"]),
  turns: z.number().int().nonnegative(), tokens: z.number().nonnegative().nullable(), error: z.string().nullable(),
});
export const scheduleProposalSchema = z.object({
  id: z.string(), schedule: scheduleContentSchema, createdAt: z.date(),
  status: z.enum(["pending", "confirmed", "dismissed"]), scheduleId: z.string().nullable(),
});
export type ScheduleContent = z.infer<typeof scheduleContentSchema>;
export type ScheduleInput = z.input<typeof scheduleContentSchema>;
export type Schedule = z.infer<typeof scheduleSchema>;
export type ScheduleRun = z.infer<typeof scheduleRunSchema>;
export type ScheduleProposal = z.infer<typeof scheduleProposalSchema>;
