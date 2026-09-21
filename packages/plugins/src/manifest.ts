import { z } from "zod";

/**
 * A plugin is access to an external service (spec §32). Plugins and skills are
 * different things: a skill tells the agent how to work, a plugin gives it a
 * capability it could not otherwise reach.
 */
export const pluginAuthenticationSchema = z.object({
  kind: z.enum(["none", "oauth", "apiKey", "custom"]),
  /**
   * Plugins sharing an account type share one account, which is how a single
   * sign-in can serve several plugins of the same provider (spec §34).
   */
  accountType: z.string().min(1).optional(),
  /** Shown to the user when connecting. */
  scopes: z.array(z.string()).default([]),
});
export type PluginAuthentication = z.infer<typeof pluginAuthenticationSchema>;

export const pluginToolSchema = z.object({
  name: z.string().min(1),
  description: z.string().default(""),
  /** JSON Schema for the tool's input, passed through to the tool bridge. */
  inputSchema: z.record(z.unknown()).default({}),
});
export type PluginTool = z.infer<typeof pluginToolSchema>;

export const pluginManifestSchema = z.object({
  schemaVersion: z.literal(1),
  id: z
    .string()
    .min(1)
    .max(100)
    .regex(/^[a-z0-9][a-z0-9-]*$/, "use lowercase letters, digits and hyphens"),
  name: z.string().min(1).max(200),
  description: z.string().max(2000).default(""),
  version: z.string().min(1).default("1.0.0"),
  authentication: pluginAuthenticationSchema.default({ kind: "none", scopes: [] }),
  tools: z.array(pluginToolSchema).default([]),
  permissions: z.array(z.string()).default([]),
  capabilities: z.array(z.string()).default([]),
});

export type PluginManifest = z.infer<typeof pluginManifestSchema>;
export type PluginManifestInput = z.input<typeof pluginManifestSchema>;

export function parsePlugin(input: unknown): PluginManifest {
  return pluginManifestSchema.parse(input);
}

/** Scopes a plugin can be enabled at (spec §35). */
export const pluginScopeSchema = z.enum([
  "global",
  "workspace",
  "session",
  "agent",
]);
export type PluginScope = z.infer<typeof pluginScopeSchema>;

export interface PluginAssignment {
  readonly pluginId: string;
  readonly enabled: boolean;
}

export interface PluginScopes {
  readonly global?: readonly PluginAssignment[];
  readonly workspace?: readonly PluginAssignment[];
  readonly session?: readonly PluginAssignment[];
  readonly agent?: readonly PluginAssignment[];
}

/**
 * A connection to an external service, owned by the application rather than by
 * any single session (spec §34). The secret lives behind a credential
 * reference; this record never holds one.
 */
export const pluginAccountSchema = z.object({
  id: z.string().min(1),
  /** Matches `authentication.accountType` of the plugins it can serve. */
  accountType: z.string().min(1),
  label: z.string().min(1),
  credentialReference: z.string().min(1),
  createdAt: z.date(),
  updatedAt: z.date(),
});
export type PluginAccount = z.infer<typeof pluginAccountSchema>;

export interface ResolvedPlugin {
  readonly plugin: PluginManifest;
  readonly decidedBy: PluginScope;
  /** The account serving this plugin, when it needs one. */
  readonly account: PluginAccount | null;
  /** False when the plugin needs an account and none is connected. */
  readonly usable: boolean;
}
