import { sql } from "drizzle-orm";
import {
  blob,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

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

/**
 * Further accounts of a tool that keeps several side by side. The tool's own
 * default home is never stored: it is always present as the provider itself.
 */
export const providerAccounts = sqliteTable(
  "provider_accounts",
  {
    id: text("id").primaryKey(),
    family: text("family").notNull(),
    label: text("label").notNull(),
    home: text("home").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [uniqueIndex("provider_accounts_family_home").on(table.family, table.home)],
);

/**
 * Terminal agents of a workspace: which tool, account, model and effort each
 * tile runs. The process itself is not persisted; after a restart a tile is
 * stopped until the person starts it again.
 */
export const agentTerminals = sqliteTable(
  "agent_terminals",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    purpose: text("purpose").notNull(),
    providerId: text("provider_id"),
    label: text("label").notNull(),
    modelId: text("model_id"),
    reasoningEffort: text("reasoning_effort"),
    permissionMode: text("permission_mode"),
    workingDirectory: text("working_directory").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [index("agent_terminals_workspace").on(table.workspaceId)],
);

/** Provider-neutral skill material (spec §29). */
export const skills = sqliteTable("skills", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  description: text("description").notNull().default(""),
  version: text("version").notNull().default("1.0.0"),
  instructions: text("instructions").notNull(),
  requiredCapabilities: text("required_capabilities", { mode: "json" })
    .$type<string[]>()
    .notNull()
    .default(sql`'[]'`),
  tools: text("tools", { mode: "json" }).$type<string[]>().notNull().default(sql`'[]'`),
  mcpDependencies: text("mcp_dependencies", { mode: "json" })
    .$type<string[]>()
    .notNull()
    .default(sql`'[]'`),
  metadata: text("metadata", { mode: "json" })
    .$type<Record<string, unknown>>()
    .notNull()
    .default(sql`'{}'`),
  source: text("source", { mode: "json" })
    .$type<Record<string, unknown>>()
    .notNull()
    .default(sql`'{}'`),
  /** The global scope of the precedence chain (spec §30). */
  enabledGlobally: integer("enabled_globally", { mode: "boolean" })
    .notNull()
    .default(false),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
});

export const workspaceSkills = sqliteTable(
  "workspace_skills",
  {
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    skillId: text("skill_id")
      .notNull()
      .references(() => skills.id, { onDelete: "cascade" }),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  },
  (table) => [primaryKey({ columns: [table.workspaceId, table.skillId] })],
);

export const sessionSkills = sqliteTable(
  "session_skills",
  {
    sessionId: text("session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    skillId: text("skill_id")
      .notNull()
      .references(() => skills.id, { onDelete: "cascade" }),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  },
  (table) => [primaryKey({ columns: [table.sessionId, table.skillId] })],
);

/** External services the application can reach (spec §32). */
export const plugins = sqliteTable("plugins", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  description: text("description").notNull().default(""),
  version: text("version").notNull().default("1.0.0"),
  authentication: text("authentication", { mode: "json" })
    .$type<Record<string, unknown>>()
    .notNull()
    .default(sql`'{}'`),
  tools: text("tools", { mode: "json" }).$type<unknown[]>().notNull().default(sql`'[]'`),
  permissions: text("permissions", { mode: "json" })
    .$type<string[]>()
    .notNull()
    .default(sql`'[]'`),
  capabilities: text("capabilities", { mode: "json" })
    .$type<string[]>()
    .notNull()
    .default(sql`'[]'`),
  enabledGlobally: integer("enabled_globally", { mode: "boolean" })
    .notNull()
    .default(false),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
});

/**
 * One connection to an external service, usable by every plugin of the same
 * account type (spec §34). It stores a credential reference, never a secret.
 */
export const pluginAccounts = sqliteTable("plugin_accounts", {
  id: text("id").primaryKey(),
  accountType: text("account_type").notNull(),
  label: text("label").notNull(),
  credentialReference: text("credential_reference").notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
});

export const workspacePlugins = sqliteTable(
  "workspace_plugins",
  {
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    pluginId: text("plugin_id")
      .notNull()
      .references(() => plugins.id, { onDelete: "cascade" }),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  },
  (table) => [primaryKey({ columns: [table.workspaceId, table.pluginId] })],
);

export const sessionPlugins = sqliteTable(
  "session_plugins",
  {
    sessionId: text("session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    pluginId: text("plugin_id")
      .notNull()
      .references(() => plugins.id, { onDelete: "cascade" }),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  },
  (table) => [primaryKey({ columns: [table.sessionId, table.pluginId] })],
);

/** MCP servers the application knows about (spec §37). */
export const mcpServers = sqliteTable("mcp_servers", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  transport: text("transport", { enum: ["stdio", "http", "sse"] })
    .notNull()
    .default("stdio"),
  command: text("command"),
  args: text("args", { mode: "json" }).$type<string[]>().notNull().default(sql`'[]'`),
  env: text("env", { mode: "json" })
    .$type<Record<string, string>>()
    .notNull()
    .default(sql`'{}'`),
  url: text("url"),
  cwd: text("cwd"),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
});

export const sessionMcpServers = sqliteTable(
  "session_mcp_servers",
  {
    sessionId: text("session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    serverId: text("server_id")
      .notNull()
      .references(() => mcpServers.id, { onDelete: "cascade" }),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  },
  (table) => [primaryKey({ columns: [table.sessionId, table.serverId] })],
);

/**
 * Encrypted secrets (spec §57). The value is whatever the operating system's
 * secret storage produced; nothing here is readable without it.
 */
export const credentials = sqliteTable("credentials", {
  reference: text("reference").primaryKey(),
  label: text("label").notNull(),
  kind: text("kind").notNull(),
  secret: blob("secret", { mode: "buffer" }).notNull(),
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
export type ProviderAccountRow = typeof providerAccounts.$inferSelect;
export type AgentTerminalRow = typeof agentTerminals.$inferSelect;
export type SkillRow = typeof skills.$inferSelect;
export type NewSkillRow = typeof skills.$inferInsert;
export type PluginRow = typeof plugins.$inferSelect;
export type NewPluginRow = typeof plugins.$inferInsert;
export type PluginAccountRow = typeof pluginAccounts.$inferSelect;
export type McpServerRow = typeof mcpServers.$inferSelect;
export type NewMcpServerRow = typeof mcpServers.$inferInsert;
export type CredentialRow = typeof credentials.$inferSelect;

/**
 * Teams and their runs (spec §40, §53). A run is persisted as it happens, so a
 * restart restores the task graph, the mail, the decisions and the artifacts
 * rather than starting over.
 */
export const teams = sqliteTable("teams", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id")
    .notNull()
    .references(() => workspaces.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  leadAgentId: text("lead_agent_id"),
  settings: text("settings", { mode: "json" })
    .$type<Record<string, unknown>>()
    .notNull()
    .default(sql`'{}'`),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
});

export const teamAgents = sqliteTable("team_agents", {
  id: text("id").primaryKey(),
  teamId: text("team_id")
    .notNull()
    .references(() => teams.id, { onDelete: "cascade" }),
  displayName: text("display_name").notNull(),
  providerId: text("provider_id").notNull(),
  modelId: text("model_id"),
  role: text("role").notNull().default(""),
  workingDirectory: text("working_directory").notNull(),
  skills: text("skills", { mode: "json" }).$type<string[]>().notNull().default(sql`'[]'`),
  plugins: text("plugins", { mode: "json" }).$type<string[]>().notNull().default(sql`'[]'`),
  mcpServers: text("mcp_servers", { mode: "json" })
    .$type<string[]>()
    .notNull()
    .default(sql`'[]'`),
  settings: text("settings", { mode: "json" })
    .$type<Record<string, unknown>>()
    .notNull()
    .default(sql`'{}'`),
  position: integer("position").notNull().default(0),
});

export const teamRuns = sqliteTable("team_runs", {
  id: text("id").primaryKey(),
  teamId: text("team_id")
    .notNull()
    .references(() => teams.id, { onDelete: "cascade" }),
  workspaceId: text("workspace_id")
    .notNull()
    .references(() => workspaces.id, { onDelete: "cascade" }),
  goal: text("goal").notNull(),
  status: text("status").notNull(),
  stopReason: text("stop_reason"),
  outcome: text("outcome"),
  sharedState: text("shared_state", { mode: "json" })
    .$type<Record<string, unknown>>()
    .notNull()
    .default(sql`'{}'`),
  limits: text("limits", { mode: "json" })
    .$type<Record<string, unknown>>()
    .notNull()
    .default(sql`'{}'`),
  agentCalls: integer("agent_calls").notNull().default(0),
  failures: integer("failures").notNull().default(0),
  messageCount: integer("message_count").notNull().default(0),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  startedAt: integer("started_at", { mode: "timestamp_ms" }),
  finishedAt: integer("finished_at", { mode: "timestamp_ms" }),
});

export const teamTasks = sqliteTable("team_tasks", {
  id: text("id").primaryKey(),
  runId: text("run_id")
    .notNull()
    .references(() => teamRuns.id, { onDelete: "cascade" }),
  title: text("title").notNull(),
  description: text("description").notNull().default(""),
  status: text("status").notNull(),
  createdBy: text("created_by").notNull(),
  assignedTo: text("assigned_to"),
  parentTaskId: text("parent_task_id"),
  dependencies: text("dependencies", { mode: "json" })
    .$type<string[]>()
    .notNull()
    .default(sql`'[]'`),
  priority: integer("priority").notNull().default(0),
  depth: integer("depth").notNull().default(0),
  delegations: integer("delegations").notNull().default(0),
  result: text("result"),
  artifacts: text("artifacts", { mode: "json" })
    .$type<string[]>()
    .notNull()
    .default(sql`'[]'`),
  error: text("error"),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  startedAt: integer("started_at", { mode: "timestamp_ms" }),
  completedAt: integer("completed_at", { mode: "timestamp_ms" }),
});

export const teamMessages = sqliteTable("team_messages", {
  id: text("id").primaryKey(),
  runId: text("run_id")
    .notNull()
    .references(() => teamRuns.id, { onDelete: "cascade" }),
  fromAgent: text("from_agent").notNull(),
  toAgent: text("to_agent").notNull(),
  type: text("type").notNull(),
  content: text("content").notNull(),
  taskId: text("task_id"),
  readAt: integer("read_at", { mode: "timestamp_ms" }),
  timestamp: integer("timestamp", { mode: "timestamp_ms" }).notNull(),
});

export const teamDecisions = sqliteTable("team_decisions", {
  id: text("id").primaryKey(),
  runId: text("run_id")
    .notNull()
    .references(() => teamRuns.id, { onDelete: "cascade" }),
  author: text("author").notNull(),
  title: text("title").notNull(),
  reason: text("reason").notNull().default(""),
  decision: text("decision").notNull(),
  relatedTasks: text("related_tasks", { mode: "json" })
    .$type<string[]>()
    .notNull()
    .default(sql`'[]'`),
  timestamp: integer("timestamp", { mode: "timestamp_ms" }).notNull(),
});

export const teamArtifacts = sqliteTable("team_artifacts", {
  id: text("id").primaryKey(),
  runId: text("run_id")
    .notNull()
    .references(() => teamRuns.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  type: text("type").notNull(),
  path: text("path"),
  content: text("content"),
  createdBy: text("created_by").notNull(),
  taskId: text("task_id"),
  metadata: text("metadata", { mode: "json" })
    .$type<Record<string, unknown>>()
    .notNull()
    .default(sql`'{}'`),
  timestamp: integer("timestamp", { mode: "timestamp_ms" }).notNull(),
});

export type TeamRow = typeof teams.$inferSelect;
export type NewTeamRow = typeof teams.$inferInsert;
export type TeamAgentRow = typeof teamAgents.$inferSelect;
export type NewTeamAgentRow = typeof teamAgents.$inferInsert;
export type TeamRunRow = typeof teamRuns.$inferSelect;
export type NewTeamRunRow = typeof teamRuns.$inferInsert;
export type TeamTaskRow = typeof teamTasks.$inferSelect;
export type TeamMessageRow = typeof teamMessages.$inferSelect;
export type TeamDecisionRow = typeof teamDecisions.$inferSelect;
export type TeamArtifactRow = typeof teamArtifacts.$inferSelect;
