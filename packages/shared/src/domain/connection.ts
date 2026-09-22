import { z } from "zod";

/**
 * A machine the application can reach over SSH, so a workspace does not have
 * to live on this computer (spec §25: a workspace is a root the application is
 * allowed to work inside; where that root is stored is a separate question).
 *
 * A connection is defined once and used by any number of workspaces, which is
 * why it is its own record rather than a field on a workspace.
 *
 * The secret is deliberately absent. Passwords, private keys and passphrases
 * live in the credential store and are referenced by name, so no part of this
 * record is unsafe to hand to the renderer.
 */
export const sshAuthMethodSchema = z.enum(["password", "key", "agent"]);
export type SshAuthMethod = z.infer<typeof sshAuthMethodSchema>;

export const sshConnectionSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1).max(120),
  host: z.string().min(1).max(255),
  port: z.number().int().min(1).max(65535),
  username: z.string().min(1).max(64),
  auth: sshAuthMethodSchema,
  /**
   * Where the secret is kept, never the secret itself. Null for agent
   * authentication, which has nothing of its own to store.
   */
  credentialReference: z.string().min(1).nullable(),
  /**
   * The host key this connection was first established with, as a SHA-256
   * fingerprint. A later connection offering a different key is refused
   * rather than trusted, so a machine cannot be silently swapped for another.
   * Null until the first successful connection records one.
   */
  hostKeyFingerprint: z.string().min(1).nullable(),
  createdAt: z.date(),
  updatedAt: z.date(),
});
export type SshConnection = z.infer<typeof sshConnectionSchema>;

export const createSshConnectionInputSchema = z.object({
  name: z.string().trim().min(1).max(120),
  host: z.string().trim().min(1).max(255),
  port: z.number().int().min(1).max(65535).default(22),
  username: z.string().trim().min(1).max(64),
  auth: sshAuthMethodSchema.default("password"),
  /**
   * The password, private key or passphrase, travelling to the main process
   * once and going straight into the credential store. It is never read back
   * out to the renderer afterwards.
   */
  secret: z.string().max(64 * 1024).optional(),
});
export type CreateSshConnectionInput = z.infer<typeof createSshConnectionInputSchema>;

export const updateSshConnectionInputSchema = z.object({
  id: z.string().min(1),
  name: z.string().trim().min(1).max(120).optional(),
  host: z.string().trim().min(1).max(255).optional(),
  port: z.number().int().min(1).max(65535).optional(),
  username: z.string().trim().min(1).max(64).optional(),
  auth: sshAuthMethodSchema.optional(),
  /** Omitted leaves the stored secret alone; a new one replaces it. */
  secret: z.string().max(64 * 1024).optional(),
  /**
   * Clears the remembered host key, so the next connection trusts and records
   * whatever the machine offers. This is how a genuinely rebuilt host is
   * accepted, and it is always the user's explicit decision.
   */
  forgetHostKey: z.boolean().optional(),
});
export type UpdateSshConnectionInput = z.infer<typeof updateSshConnectionInputSchema>;

/**
 * What came back from trying a connection. A failure is reported, never
 * thrown away and never dressed up as success: the reason is what lets the
 * user fix it.
 */
export const sshConnectionTestSchema = z.object({
  ok: z.boolean(),
  /** The server's SHA-256 host key fingerprint, when one was offered. */
  fingerprint: z.string().nullable(),
  /** True when this connection had no remembered key and now has one. */
  learnedHostKey: z.boolean(),
  /** The home directory the server resolved, proving SFTP really works. */
  homeDirectory: z.string().nullable(),
  error: z.string().nullable(),
});
export type SshConnectionTest = z.infer<typeof sshConnectionTestSchema>;
