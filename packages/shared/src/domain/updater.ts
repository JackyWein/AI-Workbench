import { z } from "zod";

/** Where the updater stands. `not-available` means the check ran: no update. */
export const updateStatusSchema = z.enum([
  "idle",
  "checking",
  "available",
  "downloading",
  "downloaded",
  "not-available",
  "error",
]);
export type UpdateStatus = z.infer<typeof updateStatusSchema>;

/**
 * The whole update state the main process owns. The renderer reads it through
 * `update.getStatus` and follows changes on the `update.*` domain events; the
 * notes come from the release and are display text only.
 */
export const updateStateSchema = z.object({
  status: updateStatusSchema,
  currentVersion: z.string(),
  availableVersion: z.string().nullable(),
  releaseNotes: z.string().max(4000).nullable(),
  error: z.string().nullable(),
  /** Download progress in percent, set while downloading. */
  progress: z.number().min(0).max(100).nullable(),
});
export type UpdateState = z.infer<typeof updateStateSchema>;
