import { z } from "zod";

export const workspaceSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1).max(200),
  /** Absolute path to the workspace root on disk. */
  path: z.string().min(1),
  settings: z.record(z.unknown()),
  createdAt: z.date(),
  updatedAt: z.date(),
});

export type Workspace = z.infer<typeof workspaceSchema>;

export const createWorkspaceInputSchema = z.object({
  name: z.string().min(1).max(200),
  path: z.string().min(1),
  settings: z.record(z.unknown()).optional(),
});

export type CreateWorkspaceInput = z.infer<typeof createWorkspaceInputSchema>;

export const updateWorkspaceInputSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1).max(200).optional(),
  path: z.string().min(1).optional(),
  settings: z.record(z.unknown()).optional(),
});

export type UpdateWorkspaceInput = z.infer<typeof updateWorkspaceInputSchema>;
