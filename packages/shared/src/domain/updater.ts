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
  /**
   * False when this build cannot replace itself — the portable Windows
   * version, the unsigned Mac build, a Linux archive — so a new version is
   * downloaded from its release page instead.
   */
  installsItself: z.boolean().default(true),
  /** Why this build cannot update itself, in words for the person. */
  manualReason: z.string().nullable().default(null),
  /** The release page of the available version, when there is one. */
  releaseUrl: z.string().url().nullable().default(null),
  /**
   * The commit this build was made from, and the one the available release
   * was made from. A release of the same version from another commit is an
   * update too: a version can be published again without a new number.
   */
  currentBuild: z.string().nullable().default(null),
  availableBuild: z.string().nullable().default(null),
  /** Whether updates download in the background and install on quit. */
  automatic: z.boolean().default(true),
  /**
   * The person answered "Later" to restarting for the downloaded update, so
   * nothing asks again until the next one; it installs when the app quits.
   */
  deferred: z.boolean().default(false),
});
export type UpdateState = z.infer<typeof updateStateSchema>;
