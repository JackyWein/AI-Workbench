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
    enabled: z.boolean().default(true),
    /** Working directory for a stdio server. */
    cwd: z.string().optional(),
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
