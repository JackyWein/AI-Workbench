import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { Logger } from "@ai-workbench/shared";
import {
  parseMcpServerConfig,
  type McpServerConfig,
  type McpServerStatus,
  type McpTool,
} from "@ai-workbench/shared";

interface Connection {
  readonly config: McpServerConfig;
  readonly client: Client;
  tools: McpTool[];
}

export interface McpManagerOptions {
  readonly logger: Logger;
  readonly clientName?: string;
  readonly clientVersion?: string;
}

/**
 * Connects to MCP servers and keeps track of what each one offers (spec §37).
 *
 * A server that will not start, or that goes away, is reported as failed and
 * never propagated as an exception: MCP is an integration, and a broken
 * integration must not take the application with it (spec §60).
 */
export class McpManager {
  readonly #connections = new Map<string, Connection>();
  readonly #statuses = new Map<string, McpServerStatus>();
  readonly #logger: Logger;
  readonly #clientName: string;
  readonly #clientVersion: string;

  constructor(options: McpManagerOptions) {
    this.#logger = options.logger.child("MCP");
    this.#clientName = options.clientName ?? "ai-workbench";
    this.#clientVersion = options.clientVersion ?? "1.0.0";
  }

  /** Connects to a server and reads its tool list. Never throws. */
  async connect(input: unknown): Promise<McpServerStatus> {
    let config: McpServerConfig;
    try {
      config = parseMcpServerConfig(input);
    } catch (error) {
      const id = typeof input === "object" && input !== null && "id" in input
        ? String((input as { id: unknown }).id)
        : "unknown";
      return this.#record({
        id,
        name: id,
        transport: "stdio",
        state: "failed",
        tools: [],
        detail: error instanceof Error ? error.message : "Invalid configuration",
        updatedAt: new Date(),
      });
    }

    await this.disconnect(config.id);

    if (config.transport !== "stdio") {
      // Remote transports are configurable and reported honestly as not yet
      // implemented, rather than pretending to connect (spec §0).
      return this.#record({
        id: config.id,
        name: config.name,
        transport: config.transport,
        state: "unsupported",
        tools: [],
        detail: `The ${config.transport} transport is configured but not implemented yet`,
        updatedAt: new Date(),
      });
    }

    this.#record({
      id: config.id,
      name: config.name,
      transport: config.transport,
      state: "connecting",
      tools: [],
      updatedAt: new Date(),
    });

    try {
      const transport = new StdioClientTransport({
        command: config.command as string,
        args: config.args,
        env: { ...(process.env as Record<string, string>), ...config.env },
        ...(config.cwd === undefined ? {} : { cwd: config.cwd }),
        stderr: "ignore",
      });

      const client = new Client(
        { name: this.#clientName, version: this.#clientVersion },
        { capabilities: {} },
      );

      await client.connect(transport);
      const listed = await client.listTools();
      const tools: McpTool[] = listed.tools.map((tool) => ({
        name: tool.name,
        description: tool.description ?? "",
        inputSchema: (tool.inputSchema ?? {}) as Record<string, unknown>,
      }));

      this.#connections.set(config.id, { config, client, tools });
      this.#logger.info("MCP server connected", {
        serverId: config.id,
        tools: tools.length,
      });

      return this.#record({
        id: config.id,
        name: config.name,
        transport: config.transport,
        state: "connected",
        tools,
        updatedAt: new Date(),
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.#logger.warn("MCP server failed to connect", {
        serverId: config.id,
        error: detail,
      });
      return this.#record({
        id: config.id,
        name: config.name,
        transport: config.transport,
        state: "failed",
        tools: [],
        detail,
        updatedAt: new Date(),
      });
    }
  }

  async disconnect(id: string): Promise<boolean> {
    const connection = this.#connections.get(id);
    if (!connection) {
      return false;
    }
    this.#connections.delete(id);
    try {
      await connection.client.close();
    } catch (error) {
      this.#logger.debug("MCP server did not close cleanly", {
        serverId: id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    const status = this.#statuses.get(id);
    if (status) {
      this.#record({ ...status, state: "disconnected", tools: [], updatedAt: new Date() });
    }
    return true;
  }

  async disconnectAll(): Promise<void> {
    await Promise.all([...this.#connections.keys()].map((id) => this.disconnect(id)));
  }

  status(id: string): McpServerStatus | undefined {
    return this.#statuses.get(id);
  }

  statuses(): McpServerStatus[] {
    return [...this.#statuses.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  isConnected(id: string): boolean {
    return this.#connections.has(id);
  }

  /** Tools of the servers a session is allowed to use (spec §38). */
  toolsForSession(enabledServerIds: readonly string[]): Array<McpTool & { serverId: string }> {
    const tools: Array<McpTool & { serverId: string }> = [];
    for (const id of enabledServerIds) {
      const connection = this.#connections.get(id);
      if (!connection) {
        continue;
      }
      for (const tool of connection.tools) {
        tools.push({ ...tool, serverId: id });
      }
    }
    return tools;
  }

  /** Calls a tool. A failure is returned, not thrown. */
  async callTool(
    serverId: string,
    name: string,
    args: Record<string, unknown> = {},
  ): Promise<{ ok: true; result: unknown } | { ok: false; error: string }> {
    const connection = this.#connections.get(serverId);
    if (!connection) {
      return { ok: false, error: `MCP server "${serverId}" is not connected` };
    }
    try {
      const result = await connection.client.callTool({ name, arguments: args });
      return { ok: true, result };
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.#logger.warn("MCP tool call failed", { serverId, tool: name, error: detail });
      return { ok: false, error: detail };
    }
  }

  #record(status: McpServerStatus): McpServerStatus {
    this.#statuses.set(status.id, status);
    return status;
  }
}
