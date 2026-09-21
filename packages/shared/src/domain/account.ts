import { z } from "zod";

/**
 * One more account of a tool that can keep several side by side, such as two
 * sign-ins of the same command line tool. Each account is a configuration home
 * the tool is pointed at, so its sign-in, settings, history and usage stay
 * apart exactly the way the tool itself keeps them apart.
 *
 * The tool's default home is not stored here: it is always present as the
 * provider itself. Every stored account becomes a provider entry of its own,
 * `<family>@<id>`, which sessions and team agents select like any other
 * provider (spec §39: "Claude + Claude + Codex").
 */
export const providerAccountSchema = z.object({
  id: z
    .string()
    .min(1)
    .max(48)
    .regex(/^[a-z0-9][a-z0-9-]*$/, "use lowercase letters, digits and hyphens"),
  /** The provider family (the tool) this account belongs to. */
  family: z.string().min(1),
  label: z.string().min(1).max(80),
  /** Absolute path of the tool's configuration home for this account. */
  home: z.string().min(1),
  createdAt: z.date(),
});
export type ProviderAccount = z.infer<typeof providerAccountSchema>;

export const addProviderAccountInputSchema = z.object({
  family: z.string().min(1),
  label: z.string().trim().min(1).max(80),
  /**
   * An existing configuration home to use. Omitted, the application creates an
   * empty one in its own data directory and the user signs in there.
   */
  home: z.string().min(1).optional(),
});
export type AddProviderAccountInput = z.infer<typeof addProviderAccountInputSchema>;

/** A configuration home found on this machine that is not connected yet. */
export const detectedProviderAccountSchema = z.object({
  family: z.string().min(1),
  /** Display name of the tool, for the suggestion. */
  toolName: z.string().min(1),
  home: z.string().min(1),
  /** A label derived from the folder, which the user may change. */
  suggestedLabel: z.string().min(1),
});
export type DetectedProviderAccount = z.infer<typeof detectedProviderAccountSchema>;

/** The provider id of an account entry; the default account keeps the family id. */
export function accountProviderId(family: string, accountId: string): string {
  return `${family}@${accountId}`;
}
