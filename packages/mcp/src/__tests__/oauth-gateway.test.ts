import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { McpGateway, McpOAuth, type McpOAuthStore, type McpOAuthTarget } from "../index.js";
import {
  startOAuthMcpTestServer as startOAuthTestServer,
  type OAuthMcpTestServer as OAuthTestServer,
} from "@ai-workbench/test-support";

const logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => logger,
};

/** The credential store, in memory. */
function memoryStore(): McpOAuthStore & { values: Map<string, string> } {
  const values = new Map<string, string>();
  let next = 1;
  return {
    values,
    load: async (reference) => values.get(reference) ?? null,
    save: async (reference, _label, value) => {
      const key = reference ?? `cred_${next++}`;
      values.set(key, value);
      return key;
    },
    delete: async (reference) => {
      values.delete(reference);
    },
  };
}

/**
 * The person's browser: it opens the sign-in page, the service approves at
 * once and redirects, and the browser follows to the app's listener.
 */
async function browser(url: string): Promise<void> {
  const page = await fetch(url, { redirect: "manual" });
  const location = page.headers.get("location");
  if (!location) {
    throw new Error(`no redirect from ${url}: ${page.status}`);
  }
  await fetch(location);
}

describe("signing in to an MCP server and using it through the gateway", () => {
  let service: OAuthTestServer;
  let gateway: McpGateway;
  let oauth: McpOAuth;
  let store: ReturnType<typeof memoryStore>;
  let opened: string[];
  let target: McpOAuthTarget;

  const start = async (tokenLifetimeSeconds?: number, authorizationEndpoint?: string): Promise<void> => {
    service = await startOAuthTestServer({
      ...(tokenLifetimeSeconds === undefined ? {} : { tokenLifetimeSeconds }),
      ...(authorizationEndpoint === undefined ? {} : { authorizationEndpoint }),
    });
    store = memoryStore();
    opened = [];
    oauth = new McpOAuth({
      store,
      logger,
      openBrowser: async (url) => {
        opened.push(url);
        await browser(url);
      },
    });
    target = { id: "files", name: "Files", url: service.url };
    gateway = new McpGateway({
      logger,
      route: async (id) =>
        id === "files"
          ? {
              url: service.url,
              name: "Files",
              authorization: async (force) => {
                const token = await oauth.accessToken(target, { force });
                return token ? `Bearer ${token}` : null;
              },
            }
          : null,
    });
    await gateway.start();
  };

  /** A tool connecting to the gateway, as a CLI would. */
  const readNote = async (key?: string): Promise<string> => {
    const endpoint = gateway.endpointFor("files");
    const client = new Client({ name: "tool", version: "1.0.0" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(endpoint.url), {
        requestInit: { headers: key ? { Authorization: key } : endpoint.headers },
      }),
    );
    try {
      const result = await client.callTool({ name: "read_note", arguments: { name: "plan" } });
      const [first] = result.content as Array<{ text: string }>;
      return first?.text ?? "";
    } finally {
      await client.close();
    }
  };

  beforeEach(() => {
    // Each test starts its own service, with its own token lifetime.
  });

  afterEach(async () => {
    await gateway.stop();
    await service.close();
  });

  it("signs in in the browser, keeps only a reference, and a tool uses the server", async () => {
    await start();
    const reference = await oauth.signIn(target);
    target = { ...target, reference };

    expect(opened).toHaveLength(1);
    // The sign-in page asked for PKCE and named this server as the resource.
    const page = new URL(opened[0] ?? "");
    expect(page.searchParams.get("code_challenge_method")).toBe("S256");
    expect(page.searchParams.get("resource")).toBe(service.url);
    expect(service.counts()).toMatchObject({ registrations: 1, codes: 1 });
    expect(service.lastResource()).toBe(service.url);
    expect(await oauth.isSignedIn(reference)).toBe(true);
    // Tokens live in the store, behind the reference, and nowhere else.
    expect(store.values.get(reference)).toContain("access_token");

    expect(await readNote()).toBe("note plan: signed in");
  });

  it("refuses a tool without the gateway's key", async () => {
    await start();
    target = { ...target, reference: await oauth.signIn(target) };
    await expect(readNote("Bearer not-the-key")).rejects.toThrow();
  });

  it("never opens a sign-in page that is not a web address", async () => {
    for (const page of ["file:///etc/passwd", "ms-settings:display", "http://attacker.example/authorize"]) {
      await start(undefined, page);
      await expect(oauth.signIn(target)).rejects.toThrow(/not a web address/);
      expect(opened).toEqual([]);
      await gateway.stop();
      await service.close();
    }
    await start();
  });

  it("renews a token that ran out, without the browser", async () => {
    await start(1);
    target = { ...target, reference: await oauth.signIn(target) };
    await new Promise((resolve) => setTimeout(resolve, 1200));

    expect(await readNote()).toBe("note plan: signed in");
    expect(service.counts().refreshes).toBeGreaterThanOrEqual(1);
    expect(opened).toHaveLength(1);
  });

  it("asks for a new sign-in when the service ends it, and never opens a browser for it", async () => {
    await start();
    target = { ...target, reference: await oauth.signIn(target) };
    service.revokeAll();

    await expect(readNote()).rejects.toThrow(/Sign in to Files|401/);
    expect(opened).toHaveLength(1);
    expect(await oauth.isSignedIn(target.reference)).toBe(false);
  });

  it("signs in again after signing out", async () => {
    await start();
    const reference = await oauth.signIn(target);
    await oauth.signOut(reference);
    expect(await oauth.isSignedIn(reference)).toBe(false);

    target = { ...target, reference: await oauth.signIn(target) };
    expect(await readNote()).toBe("note plan: signed in");
  });
});
