import { z } from "zod";

/**
 * The person's GitHub connection as the window sees it: who is connected,
 * never the token itself.
 */
export const gitHubStatusSchema = z.object({
  connected: z.boolean(),
  login: z.string().nullable(),
  /** Whether this build can sign in through GitHub's own page. */
  deviceFlowAvailable: z.boolean(),
  /** A sign-in waiting for the person to enter the code on GitHub. */
  pending: z
    .object({
      userCode: z.string(),
      verificationUri: z.string(),
      expiresAt: z.coerce.date(),
    })
    .nullable(),
  error: z.string().nullable(),
});
export type GitHubStatus = z.infer<typeof gitHubStatusSchema>;

/** A likely secret in what is about to leave the machine; only its start is shown. */
export const secretFindingSchema = z.object({
  kind: z.string(),
  file: z.string().nullable(),
  line: z.number().int(),
  preview: z.string(),
});
export type SecretFinding = z.infer<typeof secretFindingSchema>;

/** A commit either happened, or was stopped because it holds likely secrets. */
export const commitResultSchema = z.discriminatedUnion("committed", [
  z.object({ committed: z.literal(true), commit: z.string() }),
  z.object({ committed: z.literal(false), findings: z.array(secretFindingSchema) }),
]);
export type CommitResult = z.infer<typeof commitResultSchema>;
