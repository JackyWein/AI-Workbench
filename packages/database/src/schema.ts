import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

/**
 * Persistence for the first vertical slice (spec §58). Tables for providers,
 * skills, plugins, MCP, teams, terminals and the Status Island are added with
 * the goals that own them, so the schema never carries unused structure.
 */

export const workspaces = sqliteTable("workspaces", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  path: text("path").notNull(),
  settings: text("settings", { mode: "json" })
    .$type<Record<string, unknown>>()
    .notNull()
    .default(sql`'{}'`),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
});

export const sessions = sqliteTable(
  "sessions",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    type: text("type", { enum: ["solo", "team"] })
      .notNull()
      .default("solo"),
    providerId: text("provider_id"),
    modelId: text("model_id"),
    workingDirectory: text("working_directory").notNull(),
    providerSessionId: text("provider_session_id"),
    enabledSkills: text("enabled_skills", { mode: "json" })
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'`),
    enabledPlugins: text("enabled_plugins", { mode: "json" })
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'`),
    enabledMcpServers: text("enabled_mcp_servers", { mode: "json" })
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'`),
    settings: text("settings", { mode: "json" })
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'`),
    uiState: text("ui_state", { mode: "json" })
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'`),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [index("sessions_workspace_idx").on(table.workspaceId)],
);

export const chatMessages = sqliteTable(
  "chat_messages",
  {
    id: text("id").primaryKey(),
    sessionId: text("session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    role: text("role", { enum: ["user", "assistant", "system", "tool"] }).notNull(),
    content: text("content").notNull().default(""),
    status: text("status", {
      enum: ["complete", "streaming", "cancelled", "failed"],
    })
      .notNull()
      .default("complete"),
    providerId: text("provider_id"),
    modelId: text("model_id"),
    toolCalls: text("tool_calls", { mode: "json" })
      .$type<unknown[]>()
      .notNull()
      .default(sql`'[]'`),
    usage: text("usage", { mode: "json" }).$type<unknown>(),
    error: text("error"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [index("chat_messages_session_idx").on(table.sessionId, table.createdAt)],
);

/**
 * User overrides for a provider adapter (spec §15). Secrets are deliberately
 * absent: credentials belong in the OS keychain behind a reference, never in
 * this table (spec §57).
 */
export const providerConfigs = sqliteTable("provider_configs", {
  providerId: text("provider_id").primaryKey(),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  executablePath: text("executable_path"),
  arguments: text("arguments", { mode: "json" })
    .$type<string[]>()
    .notNull()
    .default(sql`'[]'`),
  baseUrl: text("base_url"),
  defaultModel: text("default_model"),
  credentialReference: text("credential_reference"),
  settings: text("settings", { mode: "json" })
    .$type<Record<string, unknown>>()
    .notNull()
    .default(sql`'{}'`),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
});

export const settings = sqliteTable("settings", {
  key: text("key").primaryKey(),
  value: text("value", { mode: "json" }).$type<unknown>().notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
});

export type WorkspaceRow = typeof workspaces.$inferSelect;
export type NewWorkspaceRow = typeof workspaces.$inferInsert;
export type SessionRow = typeof sessions.$inferSelect;
export type NewSessionRow = typeof sessions.$inferInsert;
export type ChatMessageRow = typeof chatMessages.$inferSelect;
export type NewChatMessageRow = typeof chatMessages.$inferInsert;
export type SettingRow = typeof settings.$inferSelect;
export type ProviderConfigRow = typeof providerConfigs.$inferSelect;
export type NewProviderConfigRow = typeof providerConfigs.$inferInsert;
