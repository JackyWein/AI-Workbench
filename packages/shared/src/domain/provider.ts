import { z } from "zod";
import { providerUsageSnapshotSchema } from "./usage.js";

/**
 * Capabilities are how the UI decides what to show. The UI must never branch on
 * a provider id or brand name (spec §3, §10).
 */
export const providerCapabilitySchema = z.enum([
  "chat",
  "streaming",
  "sessionResume",
  "modelSelection",
  "nativeTools",
  "toolCalls",
  "mcp",
  "terminal",
  "filesystem",
  "oauth",
  "apiKey",
  "cliAuthentication",
  "images",
  "vision",
  "web",
  "codeExecution",
  "structuredOutput",
  "usage",
  "reasoningModes",
  "contextInformation",
  "backgroundWork",
  /** The tool has its own interactive interface that can run in a terminal. */
  "interactiveTerminal",
  /** Several accounts of the tool can be used side by side. */
  "accounts",
]);
export type ProviderCapability = z.infer<typeof providerCapabilitySchema>;

export const providerCapabilitiesSchema = z.object({
  supported: z.array(providerCapabilitySchema),
});
export type ProviderCapabilities = z.infer<typeof providerCapabilitiesSchema>;

/** Transport is independent from provider identity (spec §11). */
export const providerTransportTypeSchema = z.enum([
  "in-process",
  "cli",
  "http",
  "openai-compatible",
  "mcp",
  "local-process",
  "remote-process",
  "custom",
]);
export type ProviderTransportType = z.infer<typeof providerTransportTypeSchema>;

export const authMethodSchema = z.enum([
  "none",
  "cli",
  "oauth",
  "apiKey",
  "custom",
]);
export type AuthMethod = z.infer<typeof authMethodSchema>;

export const providerMetadataSchema = z.object({
  id: z.string().min(1),
  displayName: z.string().min(1),
  description: z.string().optional(),
  adapterVersion: z.string().min(1),
  providerVersion: z.string().optional(),
  icon: z.string().optional(),
  website: z.string().url().optional(),
  /**
   * Something the user must know about this adapter, shown as-is. Used for
   * honest caveats, such as a configuration that has not been verified against
   * the real tool.
   */
  notice: z.string().optional(),
  authMethods: z.array(authMethodSchema),
  transportTypes: z.array(providerTransportTypeSchema),
  /**
   * The provider this entry belongs to. Every account of one tool shares a
   * family, so the UI can group them; for a single-account provider it is the
   * provider id itself.
   */
  family: z.string().min(1).optional(),
  /** Set when this entry is one account of a tool that has several. */
  account: z
    .object({
      id: z.string().min(1),
      label: z.string().min(1),
      /** The tool's configuration home for this account; null is its default. */
      home: z.string().nullable(),
    })
    .optional(),
});
export type ProviderMetadata = z.infer<typeof providerMetadataSchema>;

export const installationStateSchema = z.enum([
  "installed",
  "notInstalled",
  "unsupported",
  "unknown",
]);
export type InstallationState = z.infer<typeof installationStateSchema>;

export const installationStatusSchema = z.object({
  state: installationStateSchema,
  executablePath: z.string().optional(),
  version: z.string().optional(),
  detail: z.string().optional(),
});
export type InstallationStatus = z.infer<typeof installationStatusSchema>;

export const authStateSchema = z.enum([
  "authenticated",
  "authenticationRequired",
  "authenticationExpired",
  "notApplicable",
  "unsupported",
  "unknown",
]);
export type AuthState = z.infer<typeof authStateSchema>;

export const authStatusSchema = z.object({
  state: authStateSchema,
  method: authMethodSchema.optional(),
  accountLabel: z.string().optional(),
  /** The subscription or plan the tool reports, shown as the tool names it. */
  plan: z.string().optional(),
  detail: z.string().optional(),
});
export type AuthStatus = z.infer<typeof authStatusSchema>;

export const modelInfoSchema = z.object({
  id: z.string().min(1),
  displayName: z.string().min(1),
  description: z.string().optional(),
  contextWindow: z.number().int().positive().optional(),
  capabilities: z.array(providerCapabilitySchema).optional(),
  isDefault: z.boolean().optional(),
  /**
   * Reasoning effort levels this model accepts, named as the provider names
   * them. Absent means the model has no selectable effort.
   */
  reasoningEfforts: z.array(z.string().min(1)).optional(),
  defaultReasoningEffort: z.string().min(1).optional(),
  /** The provider can serve this model in a faster mode. */
  supportsFastMode: z.boolean().optional(),
  /** Groups a long list, for example by the upstream provider of a model. */
  group: z.string().min(1).optional(),
  /**
   * Where the entry came from: reported by the tool itself, shipped with the
   * profile, or entered by the user. Only "provider" is a verified fact.
   */
  source: z.enum(["provider", "profile", "user"]).optional(),
});
export type ModelInfo = z.infer<typeof modelInfoSchema>;

/**
 * How much a provider may do on its own, mapped by each adapter onto the tool's
 * native permission or sandbox system (spec §54). The application never
 * bypasses that system; it only chooses one of the modes the tool offers.
 *
 * - default   the tool's own configuration decides
 * - readOnly  read and plan, change nothing
 * - edit      change files in the working directory
 * - full      run without asking; only for trusted, isolated work
 */
export const permissionModeSchema = z.enum(["default", "readOnly", "edit", "full"]);
export type PermissionMode = z.infer<typeof permissionModeSchema>;

/** Per-session runtime choices, stored in `Session.settings`. */
export const sessionRuntimeSettingsSchema = z.object({
  reasoningEffort: z.string().min(1).optional(),
  permissionMode: permissionModeSchema.optional(),
});
export type SessionRuntimeSettings = z.infer<typeof sessionRuntimeSettingsSchema>;

/** Reads the runtime choices out of a session's free-form settings. */
export function readSessionRuntimeSettings(
  settings: Record<string, unknown>,
): SessionRuntimeSettings {
  const parsed = sessionRuntimeSettingsSchema.safeParse({
    reasoningEffort: settings["reasoningEffort"],
    permissionMode: settings["permissionMode"],
  });
  return parsed.success ? parsed.data : {};
}

/** Everything the renderer needs about one provider, in one payload. */
export const providerSummarySchema = z.object({
  metadata: providerMetadataSchema,
  installation: installationStatusSchema,
  auth: authStatusSchema,
  capabilities: providerCapabilitiesSchema,
  models: z.array(modelInfoSchema),
  /** When the model list was last read from the tool itself, if ever. */
  modelsUpdatedAt: z.date().nullable().default(null),
  usage: providerUsageSnapshotSchema.nullable(),
});
export type ProviderSummary = z.infer<typeof providerSummarySchema>;

/** Persisted configuration for an adapter instance (spec §15). */
export const providerConfigSchema = z.object({
  id: z.string().min(1),
  adapterId: z.string().min(1),
  transport: providerTransportTypeSchema,
  authType: authMethodSchema,
  executablePath: z.string().optional(),
  arguments: z.array(z.string()).optional(),
  environmentVariables: z.record(z.string()).optional(),
  baseUrl: z.string().url().optional(),
  /** Reference into the CredentialManager. Never a raw secret (spec §57). */
  credentialReference: z.string().optional(),
  defaultModel: z.string().optional(),
  settings: z.record(z.unknown()).optional(),
});
export type ProviderConfig = z.infer<typeof providerConfigSchema>;

/** The part of a provider configuration the user may edit and we persist. */
export const storedProviderConfigSchema = z.object({
  providerId: z.string().min(1),
  enabled: z.boolean(),
  executablePath: z.string().nullable(),
  arguments: z.array(z.string()),
  /**
   * OpenAI-compatible base URL of a custom provider, e.g.
   * `http://localhost:11434/v1`. Null means none is configured.
   */
  baseUrl: z.string().nullable(),
  /**
   * Reference into the CredentialManager. Never a raw secret (spec §57); the
   * renderer only ever carries this reference.
   */
  credentialReference: z.string().nullable(),
  defaultModel: z.string().nullable(),
  /** Free-form adapter settings, e.g. a user-maintained model list. */
  settings: z.record(z.unknown()),
  updatedAt: z.date(),
});
export type StoredProviderConfig = z.infer<typeof storedProviderConfigSchema>;

export const saveProviderConfigInputSchema = z.object({
  providerId: z.string().min(1),
  enabled: z.boolean().optional(),
  /** Absolute path to the executable; null clears it and returns to PATH. */
  executablePath: z.string().nullable().optional(),
  arguments: z.array(z.string()).optional(),
  /** OpenAI-compatible base URL; null clears it. */
  baseUrl: z.string().url().max(2000).nullable().optional(),
  /** Credential reference; null clears it. Never a raw secret (spec §57). */
  credentialReference: z.string().min(1).max(300).nullable().optional(),
  defaultModel: z.string().nullable().optional(),
  models: z.array(modelInfoSchema).optional(),
});
export type SaveProviderConfigInput = z.infer<typeof saveProviderConfigInputSchema>;
