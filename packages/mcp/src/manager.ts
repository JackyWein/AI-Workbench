import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
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

/** Resolves a credential reference to its secret. Main process only. */
export type McpCredentialResolver = (reference: string) => Promise<string | null>;

/**
 * Where to reach a remote server instead of its own address — the local
 * gateway, for one that signs in — or that it cannot be reached until the
 * person signs in. Null leaves the server's own address and credential.
 */
export type McpEndpointResolver = (
  config: McpServerConfig,
) => Promise<
  | { readonly url: string; readonly headers: Record<string, string> }
  | { readonly signInRequired: string }
  | null
>;

export interface McpManagerOptions {
  readonly logger: Logger;
  readonly clientName?: string;
  readonly clientVersion?: string;
  /**
   * How to turn a config's credentialReference into an Authorization header.
   * When absent, remote servers that ask for credentials fail honestly as
   * "failed" rather than throwing (spec §60).
   */
  readonly resolveCredential?: McpCredentialResolver;
}

export interface McpReconnectOptions {
  readonly attempts?: number;
  readonly baseDelayMs?: number;
}

/**
 * Connects to MCP servers and keeps track of what each one offers (spec §37).
 *
 * stdio servers are spawned locally; http servers speak streamable HTTP and
 * sse servers the older SSE transport. A server that will not start, refuses
 * credentials or goes away is reported as failed and never propagated as an
 * exception: MCP is an integration, and a broken integration must not take
 * the application with it (spec §60).
 */
export class McpManager {
  readonly #connections = new Map<string, Connection>();
  readonly #statuses = new Map<string, McpServerStatus>();
  /** Every validated config, so a failed server can be retried (reconnect). */
  readonly #lastConfig = new Map<string, McpServerConfig>();
  readonly #logger: Logger;
  readonly #clientName: string;
  readonly #clientVersion: string;
  #resolveCredential: McpCredentialResolver | undefined;
  #resolveEndpoint: McpEndpointResolver | undefined;

  constructor(options: McpManagerOptions) {
    this.#logger = options.logger.child("MCP");
    this.#clientName = options.clientName ?? "ai-workbench";
    this.#clientVersion = options.clientVersion ?? "1.0.0";
    this.#resolveCredential = options.resolveCredential;
  }

  /** Routes remote servers that sign in through the gateway. */
  setEndpointResolver(resolver: McpEndpointResolver | undefined): void {
    this.#resolveEndpoint = resolver;
  }

  /** Replaces the credential resolver, e.g. once the main process owns one. */
  setCredentialResolver(resolver: McpCredentialResolver | undefined): void {
    this.#resolveCredential = resolver;
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
    this.#lastConfig.set(config.id, config);

    this.#record({
      id: config.id,
      name: config.name,
      transport: config.transport,
      state: "connecting",
      tools: [],
      updatedAt: new Date(),
    });

    const endpoint =
      config.transport === "stdio" ? null : await this.#resolveEndpoint?.(config).catch(() => null);
    if (endpoint && "signInRequired" in endpoint) {
      return this.#record({
        id: config.id,
        name: config.name,
        transport: config.transport,
        state: "signInRequired",
        tools: [],
        detail: endpoint.signInRequired,
        updatedAt: new Date(),
      });
    }

    try {
      const started = Date.now();
      const { client, tools } = config.transport === "stdio"
        ? await this.#connectStdio(config)
        : await this.#connectRemote(config, endpoint ?? null);
      const latencyMs = Date.now() - started;

      this.#connections.set(config.id, { config, client, tools });
      this.#logger.info("MCP server connected", {
        serverId: config.id,
        transport: config.transport,
        tools: tools.length,
        latencyMs,
      });

      return this.#record({
        id: config.id,
        name: config.name,
        transport: config.transport,
        state: "connected",
        tools,
        latencyMs,
        updatedAt: new Date(),
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.#logger.warn("MCP server failed to connect", {
        serverId: config.id,
        transport: config.transport,
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

  /**
   * Retries the last known configuration with exponential backoff. Useful
   * after a failure or a dropped remote server. Never throws: the final
   * attempt's status is returned.
   */
  async reconnect(id: string, options: McpReconnectOptions = {}): Promise<McpServerStatus> {
    const config = this.#lastConfig.get(id);
    if (!config) {
      return this.#record({
        id,
        name: id,
        transport: "stdio",
        state: "failed",
        tools: [],
        detail: `No configuration known for MCP server "${id}"`,
        updatedAt: new Date(),
      });
    }
    const attempts = Math.max(1, Math.floor(options.attempts ?? 3));
    const baseDelayMs = Math.max(0, options.baseDelayMs ?? 200);
    let last: McpServerStatus | undefined;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      last = await this.connect(config);
      if (last.state === "connected") {
        return last;
      }
      if (attempt < attempts) {
        await sleep(baseDelayMs * 2 ** (attempt - 1));
      }
    }
    return last ?? this.#record({
      id: config.id,
      name: config.name,
      transport: config.transport,
      state: "failed",
      tools: [],
      detail: "Reconnect gave up without an attempt",
      updatedAt: new Date(),
    });
  }

  /**
   * Probes a connected server with a ping and records the round-trip as its
   * latency. Never throws.
   */
  async health(
    id: string,
  ): Promise<{ ok: true; latencyMs: number } | { ok: false; error: string }> {
    const connection = this.#connections.get(id);
    if (!connection) {
      return { ok: false, error: `MCP server "${id}" is not connected` };
    }
    try {
      const started = Date.now();
      await connection.client.ping();
      const latencyMs = Date.now() - started;
      const status = this.#statuses.get(id);
      if (status) {
        this.#record({ ...status, latencyMs, updatedAt: new Date() });
      }
      return { ok: true, latencyMs };
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.#logger.warn("MCP health probe failed", { serverId: id, error: detail });
      return { ok: false, error: detail };
    }
  }

  async #connectStdio(
    config: McpServerConfig,
  ): Promise<{ client: Client; tools: McpTool[] }> {
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
    return { client, tools: toMcpTools(listed.tools) };
  }

  async #connectRemote(
    config: McpServerConfig,
    endpoint: { readonly url: string; readonly headers: Record<string, string> } | null,
  ): Promise<{ client: Client; tools: McpTool[] }> {
    if (!config.url) {
      throw new Error(`A ${config.transport} server needs a url`);
    }
    const auth = endpoint
      ? { ok: true as const, headers: endpoint.headers }
      : await this.#authHeaders(config);
    if (!auth.ok) {
      throw new Error(auth.error);
    }
    const url = new URL(endpoint?.url ?? config.url);
    const transport = config.transport === "http"
      ? new StreamableHTTPClientTransport(url, { requestInit: { headers: auth.headers } })
      : new SSEClientTransport(url, { requestInit: { headers: auth.headers } });

    this.#logger.debug("MCP remote dial", {
      serverId: config.id,
      transport: config.transport,
      // The secret itself is never logged, only whether one is attached.
      withAuth: Object.keys(auth.headers).length > 0,
    });

    const client = new Client(
      { name: this.#clientName, version: this.#clientVersion },
      { capabilities: {} },
    );

    await client.connect(transport);
    const listed = await client.listTools();
    return { client, tools: toMcpTools(listed.tools) };
  }

  async #authHeaders(
    config: McpServerConfig,
  ): Promise<{ ok: true; headers: Record<string, string> } | { ok: false; error: string }> {
    if (!config.credentialReference) {
      return { ok: true, headers: {} };
    }
    if (!this.#resolveCredential) {
      return {
        ok: false,
        error: `MCP server "${config.id}" wants credential "${config.credentialReference}", but no credential resolver is configured`,
      };
    }
    const secret = await this.#resolveCredential(config.credentialReference);
    if (!secret) {
      return {
        ok: false,
        error: `MCP server "${config.id}" could not resolve credential "${config.credentialReference}"`,
      };
    }
    // Accept a ready-made "Scheme value" as well as a bare token.
    const value = /^\S+\s+\S/.test(secret) ? secret : `Bearer ${secret}`;
    return { ok: true, headers: { Authorization: value } };
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

function toMcpTools(
  tools: Array<{ name: string; description?: string; inputSchema?: unknown }>,
): McpTool[] {
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description ?? "",
    inputSchema: (tool.inputSchema ?? {}) as Record<string, unknown>,
  }));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
