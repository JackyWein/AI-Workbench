import { and, eq } from "drizzle-orm";
import type { Database } from "@ai-workbench/database";
import {
  mcpServers,
  sessionMcpServers,
  type McpServerRow,
} from "@ai-workbench/database";
import type { McpManager } from "@ai-workbench/mcp";
import {
  parseMcpServerConfig,
  type Logger,
  type McpServerConfig,
  type McpServerConfigInput,
  type McpServerStatus,
} from "@ai-workbench/shared";

export interface McpServiceOptions {
  readonly db: Database;
  readonly logger: Logger;
  readonly manager: McpManager;
  /**
   * Where remote auth secrets come from. Only the credential reference is
   * ever stored or sent anywhere; the secret is resolved here, in the main
   * process, at connect time (spec §57).
   */
  readonly credentials?: McpCredentialSource;
}

/** Anything that can turn a credential reference into its secret. */
export interface McpCredentialSource {
  resolve(reference: string): Promise<string | null>;
}

/**
 * Where a remote server's credential reference lives until the database grows
 * its own column: remote transports have no process environment, so their
 * otherwise unused env bag carries the reference under a reserved key. Only
 * the reference is stored there, never the secret (spec §57).
 */
const CREDENTIAL_ENV_KEY = "AI_WORKBENCH_MCP_CREDENTIAL_REFERENCE";

/**
 * Stores MCP server configurations, keeps the connections in step with them and
 * records which servers each session may use (spec §37, §38).
 */
export class McpService {
  readonly #db: Database;
  readonly #logger: Logger;
  readonly #manager: McpManager;

  constructor(options: McpServiceOptions) {
    this.#db = options.db;
    this.#logger = options.logger.child("MCP");
    this.#manager = options.manager;
    if (options.credentials) {
      const source = options.credentials;
      this.#manager.setCredentialResolver((reference) => source.resolve(reference));
    }
  }

  get manager(): McpManager {
    return this.#manager;
  }

  async list(): Promise<McpServerConfig[]> {
    return (await this.#db.select().from(mcpServers)).map(toConfig);
  }

  async get(id: string): Promise<McpServerConfig | null> {
    const [row] = await this.#db
      .select()
      .from(mcpServers)
      .where(eq(mcpServers.id, id))
      .limit(1);
    return row ? toConfig(row) : null;
  }

  async save(input: McpServerConfigInput): Promise<McpServerConfig> {
    const config = parseMcpServerConfig(input);
    const now = new Date();
    const existing = await this.get(config.id);

    // stdio servers really spawn a process, so their env must stay exactly
    // what the user set; a credential reference is only honored (and only
    // stored) for remote transports.
    const env = { ...config.env };
    if (config.credentialReference && config.transport !== "stdio") {
      env[CREDENTIAL_ENV_KEY] = config.credentialReference;
    } else {
      delete env[CREDENTIAL_ENV_KEY];
    }

    const values = {
      id: config.id,
      name: config.name,
      transport: config.transport,
      command: config.command ?? null,
      args: config.args,
      env,
      url: config.url ?? null,
      cwd: config.cwd ?? null,
      enabled: config.enabled,
      createdAt: existing ? undefined : now,
      updatedAt: now,
    };

    await this.#db
      .insert(mcpServers)
      .values({ ...values, createdAt: values.createdAt ?? now })
      .onConflictDoUpdate({
        target: mcpServers.id,
        set: {
          name: values.name,
          transport: values.transport,
          command: values.command,
          args: values.args,
          env: values.env,
          url: values.url,
          cwd: values.cwd,
          enabled: values.enabled,
          updatedAt: now,
        },
      });

    return config;
  }

  async delete(id: string): Promise<boolean> {
    await this.#manager.disconnect(id);
    await this.#db.delete(mcpServers).where(eq(mcpServers.id, id));
    return true;
  }

  /** Connects every enabled server. Failures are recorded, never thrown. */
  async connectEnabled(): Promise<McpServerStatus[]> {
    const configs = (await this.list()).filter((config) => config.enabled);
    const statuses: McpServerStatus[] = [];
    for (const config of configs) {
      statuses.push(await this.#manager.connect(config));
    }
    this.#logger.info("MCP servers connected", {
      requested: configs.length,
      connected: statuses.filter((status) => status.state === "connected").length,
    });
    return statuses;
  }

  async connect(id: string): Promise<McpServerStatus | null> {
    const config = await this.get(id);
    return config ? this.#manager.connect(config) : null;
  }

  /** Retries a known server with backoff. Failures are recorded, never thrown. */
  async reconnect(id: string): Promise<McpServerStatus | null> {
    const config = await this.get(id);
    return config ? this.#manager.reconnect(id) : null;
  }

  /** Probes a connected server and records its latency. Never throws. */
  async health(
    id: string,
  ): Promise<{ ok: true; latencyMs: number } | { ok: false; error: string }> {
    return this.#manager.health(id);
  }

  async disconnect(id: string): Promise<boolean> {
    return this.#manager.disconnect(id);
  }

  statuses(): McpServerStatus[] {
    return this.#manager.statuses();
  }

  /** Which servers a session may use (spec §38). */
  async enabledForSession(sessionId: string): Promise<string[]> {
    const rows = await this.#db
      .select()
      .from(sessionMcpServers)
      .where(eq(sessionMcpServers.sessionId, sessionId));
    return rows.filter((row) => row.enabled).map((row) => row.serverId);
  }

  async setSessionAccess(
    sessionId: string,
    serverId: string,
    enabled: boolean,
  ): Promise<void> {
    await this.#db
      .insert(sessionMcpServers)
      .values({ sessionId, serverId, enabled })
      .onConflictDoUpdate({
        target: [sessionMcpServers.sessionId, sessionMcpServers.serverId],
        set: { enabled },
      });
  }

  async clearSessionAccess(sessionId: string, serverId: string): Promise<void> {
    await this.#db
      .delete(sessionMcpServers)
      .where(
        and(
          eq(sessionMcpServers.sessionId, sessionId),
          eq(sessionMcpServers.serverId, serverId),
        ),
      );
  }
}

function toConfig(row: McpServerRow): McpServerConfig {
  const env = { ...row.env };
  const credentialReference = env[CREDENTIAL_ENV_KEY];
  delete env[CREDENTIAL_ENV_KEY];
  return {
    id: row.id,
    name: row.name,
    transport: row.transport,
    ...(row.command === null ? {} : { command: row.command }),
    args: row.args,
    env,
    ...(row.url === null ? {} : { url: row.url }),
    ...(row.cwd === null ? {} : { cwd: row.cwd }),
    ...(typeof credentialReference === "string" && credentialReference.length > 0
      ? { credentialReference }
      : {}),
    enabled: row.enabled,
  };
}
