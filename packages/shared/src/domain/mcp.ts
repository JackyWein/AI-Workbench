import { z } from "zod";

/**
 * How to reach an MCP server (spec §37). MCP is a first-class integration
 * point, so this configuration is part of the application's own model rather
 * than something a single provider owns.
 */
export const mcpTransportSchema = z.enum(["stdio", "http", "sse"]);
export type McpTransport = z.infer<typeof mcpTransportSchema>;

export const mcpServerConfigSchema = z
  .object({
    id: z.string().min(1).max(100),
    name: z.string().min(1).max(200),
    transport: mcpTransportSchema.default("stdio"),
    /** stdio: the executable and its arguments. */
    command: z.string().min(1).optional(),
    args: z.array(z.string()).default([]),
    env: z.record(z.string()).default({}),
    /** http and sse: the endpoint. */
    url: z.string().url().optional(),
    /**
     * Reference into the CredentialManager for remote transports. It is
     * resolved in the main process to an Authorization header at connect
     * time; the secret itself is never stored, logged or sent to the
     * renderer (spec §57).
     */
    credentialReference: z.string().min(1).max(200).optional(),
    /**
     * The header the stored key goes in, for a service that wants its own
     * (e.g. X-Goog-Api-Key) rather than "Authorization: Bearer <key>". The
     * key is then sent exactly as stored.
     */
    apiKeyHeader: z
      .string()
      .regex(/^[A-Za-z0-9-]{1,100}$/, "a header name")
      .optional(),
    enabled: z.boolean().default(true),
    /** Working directory for a stdio server. */
    cwd: z.string().optional(),
    /**
     * Where the server may be used: in every session and terminal agent, or
     * only in the listed workspaces. A session can still switch one off (or
     * on) for itself.
     */
    availability: z.enum(["everywhere", "workspaces"]).default("everywhere"),
    workspaceIds: z.array(z.string().min(1)).default([]),
    /** The catalog entry the server was added from, when it was. */
    catalogId: z.string().min(1).max(100).optional(),
    /**
     * Signs in with OAuth, the way MCP specifies it. The registration and
     * tokens live in the credential store under this reference; the main
     * process uses them and nothing else ever sees them.
     */
    oauth: z
      .object({
        reference: z.string().min(1).max(200).optional(),
        /** Asked for at sign-in; the server's own list when absent. */
        scopes: z.array(z.string().min(1)).default([]),
        /**
         * For services that do not register apps on their own (Google): the
         * OAuth client the person made for it. The secret, when the service
         * issues one, is kept with the tokens, never here.
         */
        clientId: z.string().min(1).max(500).optional(),
      })
      .optional(),
  })
  .superRefine((config, context) => {
    if (config.transport === "stdio" && !config.command) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "A stdio server needs a command",
        path: ["command"],
      });
    }
    if (config.transport !== "stdio" && !config.url) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: `A ${config.transport} server needs a url`,
        path: ["url"],
      });
    }
  });

export type McpServerConfig = z.infer<typeof mcpServerConfigSchema>;
export type McpServerConfigInput = z.input<typeof mcpServerConfigSchema>;

export function parseMcpServerConfig(input: unknown): McpServerConfig {
  return mcpServerConfigSchema.parse(input);
}

export const mcpToolSchema = z.object({
  name: z.string(),
  description: z.string().default(""),
  inputSchema: z.record(z.unknown()).default({}),
});
export type McpTool = z.infer<typeof mcpToolSchema>;

export const mcpConnectionStateSchema = z.enum([
  "disconnected",
  "connecting",
  "connected",
  "failed",
  "unsupported",
  /** It signs in with OAuth and has no valid sign-in yet. */
  "signInRequired",
]);
export type McpConnectionState = z.infer<typeof mcpConnectionStateSchema>;

export const mcpServerStatusSchema = z.object({
  id: z.string(),
  name: z.string(),
  transport: mcpTransportSchema,
  state: mcpConnectionStateSchema,
  tools: z.array(mcpToolSchema),
  /** Why the server is not connected, when it is not. */
  detail: z.string().optional(),
  /** Round-trip of the last successful connect or health probe, in ms. */
  latencyMs: z.number().nonnegative().optional(),
  updatedAt: z.date(),
});
export type McpServerStatus = z.infer<typeof mcpServerStatusSchema>;

/**
 * What the window may save about a server. Credentials are never named from
 * there: a new API key travels once and is stored by the main process, and
 * a sign-in is made with `mcp.signIn`, so the window cannot point a server
 * at a credential it was not given for.
 */
export const mcpServerSaveInputSchema = z.object({
  id: z.string().min(1).max(100),
  name: z.string().min(1).max(200),
  transport: mcpTransportSchema.default("stdio"),
  command: z.string().min(1).optional(),
  args: z.array(z.string()).default([]),
  env: z.record(z.string()).default({}),
  url: z.string().url().optional(),
  cwd: z.string().optional(),
  enabled: z.boolean().default(true),
  availability: z.enum(["everywhere", "workspaces"]).default("everywhere"),
  workspaceIds: z.array(z.string().min(1)).default([]),
  catalogId: z.string().min(1).max(100).optional(),
  oauth: z
    .object({
      scopes: z.array(z.string().min(1)).default([]),
      clientId: z.string().min(1).max(500).optional(),
    })
    .optional(),
  /** A new API key sent as the Authorization header; replaces the stored one. */
  apiKey: z.string().min(1).max(10_000).optional(),
  /** Sends the key in this header instead of Authorization. */
  apiKeyHeader: z
    .string()
    .regex(/^[A-Za-z0-9-]{1,100}$/, "a header name")
    .optional(),
  /** Forgets the stored API key. */
  clearApiKey: z.boolean().optional(),
});
export type McpServerSaveInput = z.input<typeof mcpServerSaveInputSchema>;

/**
 * An MCP server one of the person's tools is already configured with, as the
 * window sees it: never a secret value, only the names of the variables and
 * headers that carry one. Importing it is done by `key` in the main process,
 * which still holds the values and moves the secrets into secure storage.
 */
export const discoveredMcpServerSchema = z.object({
  /** Identifies this finding for the import; not a server id. */
  key: z.string().min(1),
  name: z.string().min(1),
  /** Where the tool keeps it, in words. */
  source: z.string(),
  providerId: z.string().min(1),
  providerName: z.string().min(1),
  transport: mcpTransportSchema,
  command: z.string().optional(),
  /** Arguments with anything that looks like a secret replaced. */
  args: z.array(z.string()),
  url: z.string().optional(),
  /** Variables and headers whose values are secrets. */
  secretNames: z.array(z.string()),
  /** A server with this name is connected already. */
  imported: z.boolean(),
});
export type DiscoveredMcpServer = z.infer<typeof discoveredMcpServerSchema>;
