import { createHash, randomBytes } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

export interface OAuthMcpTestServer {
  /** The MCP endpoint, protected by OAuth. */
  readonly url: string;
  readonly origin: string;
  /** How many access tokens were issued by code and by renewal. */
  readonly counts: () => { codes: number; refreshes: number; registrations: number };
  /** The `resource` the last token request named (RFC 8707). */
  readonly lastResource: () => string | null;
  /** Invalidates every token and renewal: the person must sign in again. */
  revokeAll(): void;
  close(): Promise<void>;
}

interface Grant {
  clientId: string;
  redirectUri: string;
  challenge: string;
}

/**
 * An MCP server behind OAuth the way MCP specifies it: protected resource
 * metadata (RFC 9728), authorization server metadata (RFC 8414), dynamic
 * registration (RFC 7591), authorization code with PKCE, and renewal. The
 * authorization page approves at once, as if the person clicked Allow.
 */
export async function startOAuthMcpTestServer(
  options: { tokenLifetimeSeconds?: number } = {},
): Promise<OAuthMcpTestServer> {
  const lifetime = options.tokenLifetimeSeconds ?? 3600;
  const clients = new Map<string, string[]>();
  const codes = new Map<string, Grant>();
  const accessTokens = new Map<string, number>();
  const refreshTokens = new Set<string>();
  const counts = { codes: 0, refreshes: 0, registrations: 0 };
  let lastResource: string | null = null;
  let origin = "";

  const issue = (): Record<string, unknown> => {
    const access = randomBytes(16).toString("hex");
    const refresh = randomBytes(16).toString("hex");
    accessTokens.set(access, Date.now() + lifetime * 1000);
    refreshTokens.add(refresh);
    return { access_token: access, token_type: "Bearer", expires_in: lifetime, refresh_token: refresh };
  };

  const json = (response: http.ServerResponse, status: number, body: unknown): void => {
    response.writeHead(status, { "content-type": "application/json" });
    response.end(JSON.stringify(body));
  };

  const server = http.createServer((request, response) => {
    const url = new URL(request.url ?? "/", origin);
    let body = "";
    request.on("data", (chunk: Buffer) => {
      body += chunk.toString("utf8");
    });
    request.on("end", () => {
      void (async () => {
        if (url.pathname === "/.well-known/oauth-protected-resource/mcp") {
          json(response, 200, {
            resource: `${origin}/mcp`,
            authorization_servers: [origin],
            scopes_supported: ["files"],
          });
          return;
        }
        if (url.pathname === "/.well-known/oauth-authorization-server") {
          json(response, 200, {
            issuer: origin,
            authorization_endpoint: `${origin}/authorize`,
            token_endpoint: `${origin}/token`,
            registration_endpoint: `${origin}/register`,
            response_types_supported: ["code"],
            grant_types_supported: ["authorization_code", "refresh_token"],
            code_challenge_methods_supported: ["S256"],
            token_endpoint_auth_methods_supported: ["none"],
          });
          return;
        }
        if (url.pathname === "/register" && request.method === "POST") {
          const metadata = JSON.parse(body) as { redirect_uris?: string[] };
          const clientId = `client-${randomBytes(6).toString("hex")}`;
          clients.set(clientId, metadata.redirect_uris ?? []);
          counts.registrations += 1;
          json(response, 201, { ...metadata, client_id: clientId });
          return;
        }
        if (url.pathname === "/authorize") {
          const clientId = url.searchParams.get("client_id") ?? "";
          const redirectUri = url.searchParams.get("redirect_uri") ?? "";
          if (!clients.get(clientId)?.includes(redirectUri)) {
            json(response, 400, { error: "invalid_request" });
            return;
          }
          const code = randomBytes(12).toString("hex");
          codes.set(code, {
            clientId,
            redirectUri,
            challenge: url.searchParams.get("code_challenge") ?? "",
          });
          const back = new URL(redirectUri);
          back.searchParams.set("code", code);
          back.searchParams.set("state", url.searchParams.get("state") ?? "");
          response.writeHead(302, { location: back.toString() });
          response.end();
          return;
        }
        if (url.pathname === "/token" && request.method === "POST") {
          const form = new URLSearchParams(body);
          lastResource = form.get("resource");
          if (form.get("grant_type") === "authorization_code") {
            const grant = codes.get(form.get("code") ?? "");
            codes.delete(form.get("code") ?? "");
            const verifier = form.get("code_verifier") ?? "";
            const challenge = createHash("sha256").update(verifier).digest("base64url");
            if (!grant || grant.challenge !== challenge || grant.clientId !== form.get("client_id")) {
              json(response, 400, { error: "invalid_grant" });
              return;
            }
            counts.codes += 1;
            json(response, 200, issue());
            return;
          }
          if (form.get("grant_type") === "refresh_token") {
            const refresh = form.get("refresh_token") ?? "";
            if (!refreshTokens.delete(refresh)) {
              json(response, 400, { error: "invalid_grant" });
              return;
            }
            counts.refreshes += 1;
            json(response, 200, issue());
            return;
          }
          json(response, 400, { error: "unsupported_grant_type" });
          return;
        }
        if (url.pathname === "/mcp") {
          const token = /^Bearer (\S+)$/.exec(request.headers.authorization ?? "")?.[1] ?? "";
          const expires = accessTokens.get(token);
          if (expires === undefined || expires < Date.now()) {
            response.writeHead(401, {
              "www-authenticate": `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"`,
            });
            response.end();
            return;
          }
          if (request.method !== "POST") {
            response.writeHead(405).end();
            return;
          }
          const mcp = new McpServer({ name: "files", version: "1.0.0" });
          mcp.registerTool(
            "read_note",
            { description: "Reads a note", inputSchema: { name: z.string() } },
            async ({ name }) => ({ content: [{ type: "text", text: `note ${name}: signed in` }] }),
          );
          const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
          await mcp.connect(transport);
          await transport.handleRequest(request, response, JSON.parse(body) as unknown);
          return;
        }
        response.writeHead(404).end();
      })();
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    url: `${origin}/mcp`,
    origin,
    counts: () => ({ ...counts }),
    lastResource: () => lastResource,
    revokeAll: () => {
      accessTokens.clear();
      refreshTokens.clear();
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}
