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
  authMethods: z.array(authMethodSchema),
  transportTypes: z.array(providerTransportTypeSchema),
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
});
export type ModelInfo = z.infer<typeof modelInfoSchema>;

/** Everything the renderer needs about one provider, in one payload. */
export const providerSummarySchema = z.object({
  metadata: providerMetadataSchema,
  installation: installationStatusSchema,
  auth: authStatusSchema,
  capabilities: providerCapabilitiesSchema,
  models: z.array(modelInfoSchema),
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
