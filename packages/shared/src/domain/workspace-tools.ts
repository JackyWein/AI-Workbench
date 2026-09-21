import { z } from "zod";

/** Entries of a workspace directory listing (spec §27). */
export const directoryEntrySchema = z.object({
  name: z.string(),
  /** Relative to the session's working directory, with forward slashes. */
  path: z.string(),
  kind: z.enum(["file", "directory", "other"]),
  size: z.number().nonnegative(),
  modifiedAt: z.date(),
});
export type DirectoryEntry = z.infer<typeof directoryEntrySchema>;

export const fileContentsSchema = z.object({
  path: z.string(),
  content: z.string(),
  truncated: z.boolean(),
  size: z.number().nonnegative(),
  binary: z.boolean(),
});
export type FileContents = z.infer<typeof fileContentsSchema>;

/** Repository state for a working directory (spec §28). */
export const gitChangeKindSchema = z.enum([
  "modified",
  "added",
  "deleted",
  "renamed",
  "copied",
  "untracked",
  "conflicted",
]);
export type GitChangeKind = z.infer<typeof gitChangeKindSchema>;

export const gitFileChangeSchema = z.object({
  path: z.string(),
  kind: gitChangeKindSchema,
  staged: z.boolean(),
  previousPath: z.string().optional(),
});
export type GitFileChange = z.infer<typeof gitFileChangeSchema>;

export const gitStatusSchema = z.object({
  isRepository: z.boolean(),
  branch: z.string().nullable(),
  detached: z.boolean(),
  upstream: z.string().nullable(),
  ahead: z.number().int(),
  behind: z.number().int(),
  changes: z.array(gitFileChangeSchema),
  clean: z.boolean(),
});
export type GitStatus = z.infer<typeof gitStatusSchema>;

/** A live terminal attached to a session (spec §26). */
export const terminalInfoSchema = z.object({
  id: z.string().min(1),
  sessionId: z.string().min(1),
  cwd: z.string(),
  shell: z.string(),
  cols: z.number().int().positive(),
  rows: z.number().int().positive(),
});
export type TerminalInfo = z.infer<typeof terminalInfoSchema>;

/**
 * Terminal output travels on its own channel rather than the domain event bus:
 * it is high frequency, byte oriented and interesting only to the view showing
 * that terminal.
 */
export const TERMINAL_EVENT_CHANNEL = "workbench:terminal" as const;

export const terminalEventSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("data"),
    terminalId: z.string(),
    chunk: z.string(),
  }),
  z.object({
    type: z.literal("exit"),
    terminalId: z.string(),
    exitCode: z.number().int(),
  }),
]);
export type TerminalEvent = z.infer<typeof terminalEventSchema>;
