import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { Server as McpProtocolServer } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { Logger, McpTool } from "@ai-workbench/shared";

/** How the gateway reaches one server, resolved at each request. */
export interface McpGatewayRoute {
  readonly url: string;
  readonly name: string;
  /**
   * The Authorization header to send, or null when the person has to sign
   * in. `force` asks for a renewed one after the server refused the last.
   */
  authorization(force: boolean): Promise<string | null>;
}

/** The tools of several servers, for a tool that takes only one server. */
export interface McpGatewayTools {
  list(serverIds: readonly string[]): Array<McpTool & { serverId: string }>;
  call(serverId: string, name: string, args: Record<string, unknown>): Promise<unknown>;
}

export interface McpGatewayOptions {
  readonly logger: Logger;
  readonly route: (serverId: string) => Promise<McpGatewayRoute | null>;
  /** Serves the combined endpoint (`endpointForAll`); without it there is none. */
  readonly tools?: McpGatewayTools;
  /** How requests go out; the main process passes one that honours the system proxy. */
  readonly fetch?: typeof fetch;
}

/** The largest request body forwarded; MCP messages are small JSON. */
const MAX_BODY_BYTES = 10 * 1024 * 1024;

/** Request headers a server needs to see from the tool, and nothing else. */
const FORWARDED_REQUEST_HEADERS = [
  "content-type",
  "accept",
  "mcp-session-id",
  "mcp-protocol-version",
  "last-event-id",
];

/** Response headers the tool needs back. */
const FORWARDED_RESPONSE_HEADERS = ["content-type", "mcp-session-id", "cache-control"];

/**
 * A local stand-in for remote MCP servers that need a sign-in. Tools connect
 * to 127.0.0.1 with a key only this run of the application hands out; the
 * gateway adds the real credential — renewed when it runs out — and passes
 * the conversation through unchanged.
 *
 * So a token never appears on a tool's command line or in its configuration,
 * a terminal agent that runs for hours keeps working past the token's
 * lifetime, and every tool reaches every server the same way.
 */
export class McpGateway {
  readonly #logger: Logger;
  readonly #route: McpGatewayOptions["route"];
  readonly #fetch: typeof fetch;
  readonly #tools: McpGatewayTools | undefined;
  readonly #secret = randomBytes(32).toString("hex");
  /** Combined endpoints handed out, by token: the servers each one serves. */
  readonly #scopes = new Map<string, readonly string[]>();
  #server: Server | null = null;
  #port = 0;

  constructor(options: McpGatewayOptions) {
    this.#logger = options.logger.child("MCP");
    this.#route = options.route;
    this.#tools = options.tools;
    this.#fetch = options.fetch ?? fetch;
  }

  /**
   * One endpoint serving the tools of all these servers, named
   * `<server>__<tool>`, for a tool that can take only one server. The same
   * set of servers always gets the same endpoint; its address is its key.
   */
  endpointForAll(serverIds: readonly string[]): { url: string; headers: Record<string, string> } {
    if (!this.#server) {
      throw new Error("The MCP gateway has not started");
    }
    const ids = [...new Set(serverIds)].sort();
    const key = ids.join("\n");
    let token = [...this.#scopes.entries()].find(([, scope]) => scope.join("\n") === key)?.[0];
    if (!token) {
      token = randomBytes(16).toString("hex");
      this.#scopes.set(token, ids);
    }
    return { url: `http://127.0.0.1:${this.#port}/mcp-all/${token}`, headers: {} };
  }

  async start(): Promise<void> {
    if (this.#server) {
      return;
    }
    const server = createServer((request, response) => {
      void this.#handle(request, response).catch((error: unknown) => {
        this.#logger.warn("MCP gateway request failed", {
          error: error instanceof Error ? error.message : String(error),
        });
        if (!response.headersSent) {
          response.writeHead(502, { "content-type": "application/json" });
        }
        response.end();
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    this.#server = server;
    this.#port = (server.address() as AddressInfo).port;
    this.#logger.info("MCP gateway listening", { port: this.#port });
  }

  /** Where a tool reaches this server, and the key it must present. */
  endpointFor(serverId: string): { url: string; headers: Record<string, string> } {
    if (!this.#server) {
      throw new Error("The MCP gateway has not started");
    }
    return {
      url: `http://127.0.0.1:${this.#port}/mcp/${encodeURIComponent(serverId)}`,
      headers: { Authorization: `Bearer ${this.#secret}` },
    };
  }

  async stop(): Promise<void> {
    const server = this.#server;
    this.#server = null;
    if (!server) {
      return;
    }
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections?.();
    });
  }

  async #handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    // A combined endpoint's address is its own key: 128 random bits, made
    // for one run of the application, on the loopback address only. Tools
    // that start MCP servers with a scrubbed environment (Gemini CLI keeps
    // anything named like a credential from them) can still be given it.
    const all = /^\/mcp-all\/([0-9a-f]{32})$/.exec(url.pathname);
    if (all?.[1]) {
      await this.#serveAll(request, response, this.#scopes.get(all[1]) ?? null);
      return;
    }
    if (!this.#authorized(request.headers.authorization)) {
      response.writeHead(401, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "unauthorized" }));
      return;
    }
    const match = /^\/mcp\/([^/]+)(\/__endpoint)?$/.exec(url.pathname);
    const serverId = match?.[1] ? decodeURIComponent(match[1]) : null;
    const route = serverId ? await this.#route(serverId) : null;
    if (!route || !serverId) {
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "unknown server" }));
      return;
    }

    // The older SSE transport posts its messages to an endpoint the server
    // names; the gateway rewrote that to itself and carries the real one.
    let target = route.url;
    if (match?.[2]) {
      const named = url.searchParams.get("u");
      if (!named || new URL(named).origin !== new URL(route.url).origin) {
        response.writeHead(400).end();
        return;
      }
      target = named;
    }

    const body = await readBody(request);
    const headers = new Headers();
    for (const name of FORWARDED_REQUEST_HEADERS) {
      const value = request.headers[name];
      if (typeof value === "string") {
        headers.set(name, value);
      }
    }

    const send = async (force: boolean): Promise<Response | null> => {
      const authorization = await route.authorization(force);
      if (authorization === null) {
        return null;
      }
      const outgoing = new Headers(headers);
      outgoing.set("authorization", authorization);
      const abort = new AbortController();
      response.on("close", () => abort.abort());
      return this.#fetch(target, {
        method: request.method ?? "GET",
        headers: outgoing,
        ...(body && request.method !== "GET" && request.method !== "HEAD" ? { body } : {}),
        signal: abort.signal,
      });
    };

    let upstream = await send(false);
    if (upstream?.status === 401) {
      // The token ran out between renewals, or the service revoked it:
      // renew once and try again before giving up.
      await upstream.body?.cancel();
      upstream = await send(true);
    }
    if (upstream === null) {
      response.writeHead(401, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          jsonrpc: "2.0",
          error: { code: -32001, message: `Sign in to ${route.name} in AI Workbench to use it.` },
          id: null,
        }),
      );
      return;
    }

    const responseHeaders: Record<string, string> = {};
    for (const name of FORWARDED_RESPONSE_HEADERS) {
      const value = upstream.headers.get(name);
      if (value !== null) {
        responseHeaders[name] = value;
      }
    }
    response.writeHead(upstream.status, responseHeaders);
    if (!upstream.body) {
      response.end();
      return;
    }
    const isEventStream = (upstream.headers.get("content-type") ?? "").includes("text/event-stream");
    const rewrite = isEventStream && request.method === "GET" && !match?.[2];
    await pipe(upstream.body, response, rewrite ? (text) => this.#rewriteEndpoint(text, serverId, target) : null);
  }

  /**
   * The combined endpoint: a stateless MCP server whose tools are the listed
   * servers' tools, each call handed to the server it belongs to.
   */
  async #serveAll(
    request: IncomingMessage,
    response: ServerResponse,
    serverIds: readonly string[] | null,
  ): Promise<void> {
    const tools = this.#tools;
    if (!serverIds || !tools) {
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "unknown endpoint" }));
      return;
    }
    if (request.method !== "POST") {
      // Stateless: there is no stream to open and no session to end.
      response.writeHead(405).end();
      return;
    }
    const body = await readBody(request);
    const server = new McpProtocolServer(
      { name: "ai-workbench", version: "1.0.0" },
      { capabilities: { tools: {} } },
    );
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: tools.list(serverIds).map((tool) => ({
        name: `${tool.serverId}__${tool.name}`,
        description: tool.description,
        inputSchema: { type: "object" as const, ...tool.inputSchema },
      })),
    }));
    server.setRequestHandler(CallToolRequestSchema, async (call) => {
      const separator = call.params.name.indexOf("__");
      const serverId = separator > 0 ? call.params.name.slice(0, separator) : "";
      const name = call.params.name.slice(separator + 2);
      if (!serverIds.includes(serverId)) {
        return { content: [{ type: "text" as const, text: `No tool named ${call.params.name}.` }], isError: true };
      }
      return (await tools.call(serverId, name, call.params.arguments ?? {})) as never;
    });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    await server.connect(transport);
    response.on("close", () => {
      void transport.close();
      void server.close();
    });
    await transport.handleRequest(request, response, body ? (JSON.parse(body.toString("utf8")) as unknown) : undefined);
  }

  /**
   * The SSE transport's `endpoint` event names where to post messages,
   * usually relative to the server. Pointed at the gateway instead, carrying
   * the real address, so the tool's posts come through here too.
   */
  #rewriteEndpoint(chunk: string, serverId: string, base: string): string {
    return chunk.replace(/(event: endpoint\r?\ndata: )([^\r\n]+)/g, (_all, prefix: string, data: string) => {
      const real = new URL(data.trim(), base).toString();
      return `${prefix}/mcp/${encodeURIComponent(serverId)}/__endpoint?u=${encodeURIComponent(real)}`;
    });
  }

  #authorized(header: string | undefined): boolean {
    const expected = Buffer.from(`Bearer ${this.#secret}`);
    const given = Buffer.from(header ?? "");
    return given.length === expected.length && timingSafeEqual(given, expected);
  }
}

async function readBody(request: IncomingMessage): Promise<Buffer | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > MAX_BODY_BYTES) {
      throw new Error("The request is too large");
    }
    chunks.push(buffer);
  }
  return chunks.length > 0 ? Buffer.concat(chunks) : null;
}

async function pipe(
  body: ReadableStream<Uint8Array>,
  response: ServerResponse,
  transform: ((text: string) => string) | null,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      if (transform) {
        response.write(transform(decoder.decode(value, { stream: true })));
      } else {
        response.write(value);
      }
    }
  } catch {
    // The tool went away or the server closed the stream; either ends it.
  } finally {
    response.end();
  }
}
