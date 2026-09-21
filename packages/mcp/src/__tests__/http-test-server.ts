import http from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

export interface HttpTestServer {
  readonly url: string;
  close(): Promise<void>;
}

function createMcpServer(): McpServer {
  const server = new McpServer({ name: "http-echo-server", version: "1.0.0" });

  server.registerTool(
    "echo",
    {
      description: "Returns the text it was given",
      inputSchema: { text: z.string() },
    },
    async ({ text }) => ({ content: [{ type: "text", text: `echo:${text}` }] }),
  );

  server.registerTool(
    "add",
    {
      description: "Adds two numbers",
      inputSchema: { a: z.number(), b: z.number() },
    },
    async ({ a, b }) => ({ content: [{ type: "text", text: String(a + b) }] }),
  );

  server.registerTool(
    "explode",
    { description: "Always fails", inputSchema: {} },
    async () => {
      throw new Error("tool exploded");
    },
  );

  return server;
}

/**
 * A real MCP server over stateless streamable HTTP on 127.0.0.1, so the
 * manager's remote transport is verified against the protocol rather than a
 * stub. When expectedAuth is set, every request without that exact
 * Authorization header is rejected with a 401 before it reaches the protocol.
 *
 * Stateless mode serves every request with a fresh transport and server, the
 * pattern the SDK documents for it; there is no session state to keep.
 */
export async function startHttpTestServer(
  options: { expectedAuth?: string } = {},
): Promise<HttpTestServer> {
  const httpServer = http.createServer((request, response) => {
    if (
      options.expectedAuth !== undefined &&
      request.headers.authorization !== options.expectedAuth
    ) {
      response.statusCode = 401;
      response.end("unauthorized");
      return;
    }
    if (request.method === "DELETE") {
      response.statusCode = 200;
      response.end();
      return;
    }
    if (request.method !== "POST") {
      response.statusCode = 405;
      response.end("method not allowed");
      return;
    }
    let body = "";
    request.on("data", (chunk: unknown) => {
      body += String(chunk);
    });
    request.on("end", () => {
      void (async () => {
        try {
          const parsed: unknown = body.length > 0 ? JSON.parse(body) : undefined;
          const transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: undefined,
          });
          await createMcpServer().connect(transport);
          await transport.handleRequest(request, response, parsed);
        } catch (error: unknown) {
          if (!response.headersSent) {
            response.statusCode = 500;
          }
          response.end(error instanceof Error ? error.message : "request failed");
        }
      })();
    });
  });

  await new Promise<void>((resolve) => {
    httpServer.listen(0, "127.0.0.1", resolve);
  });
  const address = httpServer.address();
  if (typeof address !== "object" || address === null) {
    throw new Error("Test server did not bind to a port");
  }

  return {
    url: `http://127.0.0.1:${address.port}/mcp`,
    async close(): Promise<void> {
      await new Promise<void>((resolve) => {
        httpServer.close(() => resolve());
      });
    },
  };
}
