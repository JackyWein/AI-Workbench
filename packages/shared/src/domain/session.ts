import { z } from "zod";

export const sessionTypeSchema = z.enum(["solo", "team"]);
export type SessionType = z.infer<typeof sessionTypeSchema>;

/**
 * Semantic session status. Solo sessions never report a fabricated percentage
 * (master spec §27); they report what the session is actually doing.
 */
export const sessionStatusSchema = z.enum([
  "idle",
  "planning",
  "working",
  "streaming",
  "waiting",
  "error",
]);
export type SessionStatus = z.infer<typeof sessionStatusSchema>;

export const sessionSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1).max(200),
  type: sessionTypeSchema,
  workspaceId: z.string().min(1),
  providerId: z.string().min(1).nullable(),
  modelId: z.string().min(1).nullable(),
  workingDirectory: z.string().min(1),
  /** Provider-native session id, when the provider supports resuming. */
  providerSessionId: z.string().min(1).nullable(),
  enabledSkills: z.array(z.string()),
  enabledPlugins: z.array(z.string()),
  enabledMcpServers: z.array(z.string()),
  settings: z.record(z.unknown()),
  uiState: z.record(z.unknown()),
  createdAt: z.date(),
  updatedAt: z.date(),
});

export type Session = z.infer<typeof sessionSchema>;

export const createSessionInputSchema = z.object({
  workspaceId: z.string().min(1),
  name: z.string().min(1).max(200),
  type: sessionTypeSchema.default("solo"),
  providerId: z.string().min(1).optional(),
  modelId: z.string().min(1).optional(),
  /** Defaults to the workspace path when omitted. */
  workingDirectory: z.string().min(1).optional(),
  enabledSkills: z.array(z.string().min(1)).max(200).optional(),
  enabledPlugins: z.array(z.string().min(1)).max(200).optional(),
  enabledMcpServers: z.array(z.string().min(1)).max(200).optional(),
  settings: z.record(z.unknown()).optional(),
  uiState: z.record(z.unknown()).optional(),
});

export type CreateSessionInput = z.infer<typeof createSessionInputSchema>;

export const updateSessionInputSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1).max(200).optional(),
  providerId: z.string().min(1).nullable().optional(),
  modelId: z.string().min(1).nullable().optional(),
  workingDirectory: z.string().min(1).optional(),
  enabledSkills: z.array(z.string().min(1)).max(200).optional(),
  enabledPlugins: z.array(z.string().min(1)).max(200).optional(),
  enabledMcpServers: z.array(z.string().min(1)).max(200).optional(),
  settings: z.record(z.unknown()).optional(),
  uiState: z.record(z.unknown()).optional(),
});

export type UpdateSessionInput = z.infer<typeof updateSessionInputSchema>;
