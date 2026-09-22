import { z } from "zod";

export const workspaceSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1).max(200),
  /** Absolute path to the workspace root, on this machine or on the host. */
  path: z.string().min(1),
  /**
   * The SSH connection the root lives on, or null for this machine. The path
   * means the same thing either way, which is what lets the file browser, the
   * editor and everything above them stay unaware of where a workspace is.
   */
  connectionId: z.string().min(1).nullable().default(null),
  settings: z.record(z.unknown()),
  createdAt: z.date(),
  updatedAt: z.date(),
});

export type Workspace = z.infer<typeof workspaceSchema>;

export const createWorkspaceInputSchema = z.object({
  name: z.string().min(1).max(200),
  path: z.string().min(1),
  /** Omitted or null puts the workspace on this machine. */
  connectionId: z.string().min(1).nullable().optional(),
  settings: z.record(z.unknown()).optional(),
});

export type CreateWorkspaceInput = z.infer<typeof createWorkspaceInputSchema>;

export const updateWorkspaceInputSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1).max(200).optional(),
  path: z.string().min(1).optional(),
  connectionId: z.string().min(1).nullable().optional(),
  settings: z.record(z.unknown()).optional(),
});

export type UpdateWorkspaceInput = z.infer<typeof updateWorkspaceInputSchema>;
