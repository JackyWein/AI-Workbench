import { and, eq } from "drizzle-orm";
import type { Database } from "@ai-workbench/database";
import {
  mcpServers,
  sessionMcpServers,
  type McpServerRow,
} from "@ai-workbench/database";
import {
  parseMcpServerConfig,
  type McpManager,
  type McpServerConfig,
  type McpServerConfigInput,
  type McpServerStatus,
} from "@ai-workbench/mcp";
import type { Logger } from "@ai-workbench/shared";

export interface McpServiceOptions {
  readonly db: Database;
  readonly logger: Logger;
  readonly manager: McpManager;
}

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

    const values = {
      id: config.id,
      name: config.name,
      transport: config.transport,
      command: config.command ?? null,
      args: config.args,
      env: config.env,
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
  return {
    id: row.id,
    name: row.name,
    transport: row.transport,
    ...(row.command === null ? {} : { command: row.command }),
    args: row.args,
    env: row.env,
    ...(row.url === null ? {} : { url: row.url }),
    ...(row.cwd === null ? {} : { cwd: row.cwd }),
    enabled: row.enabled,
  };
}
