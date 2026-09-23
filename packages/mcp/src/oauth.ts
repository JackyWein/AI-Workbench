import { randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { auth, type OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import type { Logger } from "@ai-workbench/shared";

/**
 * Where sign-ins are kept: the credential store, behind a reference. The
 * stored value holds the app's registration with the service and the tokens;
 * it never leaves the main process.
 */
export interface McpOAuthStore {
  load(reference: string): Promise<string | null>;
  /** Saves under the reference, or a new one when null; returns it. */
  save(reference: string | null, label: string, value: string): Promise<string>;
  delete(reference: string): Promise<void>;
}

/** What one server needs to sign in. */
export interface McpOAuthTarget {
  readonly id: string;
  readonly name: string;
  readonly url: string;
  readonly reference?: string | undefined;
  readonly scopes?: readonly string[] | undefined;
  /** An OAuth client the person registered, for services without registration. */
  readonly clientId?: string | undefined;
  readonly clientSecret?: string | undefined;
}

interface StoredSignIn {
  client?: OAuthClientInformationMixed;
  /** True when the client came from the person, not from registration. */
  presetClient?: boolean;
  tokens?: OAuthTokens;
  /** When the tokens were issued, to know when they run out. */
  obtainedAt?: number;
  discovery?: unknown;
}

export class McpSignInRequiredError extends Error {
  constructor(name: string) {
    super(`Sign in to ${name} to use it.`);
    this.name = "McpSignInRequiredError";
  }
}

/** Tokens are renewed this long before they run out. */
const REFRESH_MARGIN_MS = 60_000;
/** How long the browser sign-in may take. */
const SIGN_IN_TIMEOUT_MS = 5 * 60_000;

export interface McpOAuthOptions {
  readonly store: McpOAuthStore;
  readonly logger: Logger;
  /** Opens the service's sign-in page in the person's browser. */
  readonly openBrowser: (url: string) => void | Promise<void>;
  /** How HTTP requests go out; the main process passes one that honours the system proxy. */
  readonly fetch?: typeof fetch;
  readonly clientName?: string;
}

/**
 * Signs in to remote MCP servers the way MCP specifies (OAuth 2.1 with PKCE,
 * the server's protected resource metadata, dynamic registration where the
 * service offers it) and keeps the tokens fresh.
 *
 * Only a person starts a sign-in: renewing tokens happens on its own, but a
 * sign-in that has run out is reported as needed, never opened in a browser
 * behind their back.
 */
export class McpOAuth {
  readonly #store: McpOAuthStore;
  readonly #logger: Logger;
  readonly #openBrowser: (url: string) => void | Promise<void>;
  readonly #fetch: typeof fetch;
  readonly #clientName: string;
  readonly #refreshing = new Map<string, Promise<string | null>>();

  constructor(options: McpOAuthOptions) {
    this.#store = options.store;
    this.#logger = options.logger.child("MCP");
    this.#openBrowser = options.openBrowser;
    this.#fetch = options.fetch ?? fetch;
    this.#clientName = options.clientName ?? "AI Workbench";
  }

  /**
   * Runs the browser sign-in and returns where it is kept. The service
   * redirects back to a listener on this computer's loopback address, which
   * only accepts the answer to this very sign-in.
   */
  async signIn(target: McpOAuthTarget): Promise<string> {
    let stored = await this.#read(target.reference);
    const listener = await listenForCallback();
    const state = randomBytes(16).toString("hex");
    try {
      const redirectUrl = listener.url;
      // A registration made for another loopback port does not accept this
      // one; register again rather than fail at the service.
      if (
        stored.client &&
        !stored.presetClient &&
        "redirect_uris" in stored.client &&
        !(stored.client.redirect_uris ?? []).includes(redirectUrl)
      ) {
        delete stored.client;
      }
      if (target.clientId) {
        stored.client = {
          client_id: target.clientId,
          ...(target.clientSecret ? { client_secret: target.clientSecret } : {}),
        };
        stored.presetClient = true;
      }
      // A fresh sign-in replaces whatever tokens were there.
      delete stored.tokens;
      let verifier = "";
      const provider = this.#provider(stored, {
        redirectUrl,
        state,
        onRedirect: (url) => this.#openBrowser(url.toString()),
        onVerifier: (value) => {
          verifier = value;
        },
        verifier: () => verifier,
      });
      const scope = target.scopes?.length ? target.scopes.join(" ") : undefined;
      const first = await auth(provider, {
        serverUrl: target.url,
        ...(scope ? { scope } : {}),
        fetchFn: this.#fetch,
      });
      if (first === "REDIRECT") {
        const code = await listener.code(state, SIGN_IN_TIMEOUT_MS);
        await auth(provider, {
          serverUrl: target.url,
          authorizationCode: code,
          ...(scope ? { scope } : {}),
          fetchFn: this.#fetch,
        });
      }
      stored = provider.stored;
      if (!stored.tokens) {
        throw new Error(`${target.name} did not return a sign-in.`);
      }
      const reference = await this.#store.save(
        target.reference ?? null,
        `${target.name} sign-in`,
        JSON.stringify(stored),
      );
      this.#logger.info("Signed in", { serverId: target.id });
      return reference;
    } finally {
      listener.close();
    }
  }

  /** Whether there are tokens at all; they may still need renewing. */
  async isSignedIn(reference: string | undefined): Promise<boolean> {
    if (!reference) {
      return false;
    }
    return (await this.#read(reference)).tokens !== undefined;
  }

  /**
   * A valid access token, renewed when it is about to run out; null when the
   * person has to sign in (again). Never opens a browser.
   */
  async accessToken(target: McpOAuthTarget, options: { force?: boolean } = {}): Promise<string | null> {
    if (!target.reference) {
      return null;
    }
    const stored = await this.#read(target.reference);
    const tokens = stored.tokens;
    if (!tokens) {
      return null;
    }
    const expiresAt =
      tokens.expires_in !== undefined && stored.obtainedAt !== undefined
        ? stored.obtainedAt + tokens.expires_in * 1000
        : Number.POSITIVE_INFINITY;
    if (!options.force && expiresAt - REFRESH_MARGIN_MS > Date.now()) {
      return tokens.access_token;
    }
    if (!tokens.refresh_token) {
      return options.force ? null : expiresAt > Date.now() ? tokens.access_token : null;
    }
    // One renewal per server at a time; everyone waiting gets its result.
    const pending = this.#refreshing.get(target.reference);
    if (pending) {
      return pending;
    }
    const renewal = this.#renew(target, stored).finally(() => {
      this.#refreshing.delete(target.reference ?? "");
    });
    this.#refreshing.set(target.reference, renewal);
    return renewal;
  }

  /** Forgets a sign-in. */
  async signOut(reference: string | undefined): Promise<void> {
    if (reference) {
      await this.#store.delete(reference);
    }
  }

  async #renew(target: McpOAuthTarget, stored: StoredSignIn): Promise<string | null> {
    const provider = this.#provider(stored, {
      // Renewing never needs the browser; a service that would send the
      // person there means the sign-in is over.
      redirectUrl: "http://127.0.0.1/renewal",
      state: "",
      onRedirect: () => {
        throw new McpSignInRequiredError(target.name);
      },
      onVerifier: () => undefined,
      verifier: () => "",
    });
    try {
      const result = await auth(provider, { serverUrl: target.url, fetchFn: this.#fetch });
      if (result !== "AUTHORIZED" || !provider.stored.tokens) {
        return null;
      }
      await this.#store.save(target.reference ?? null, `${target.name} sign-in`, JSON.stringify(provider.stored));
      return provider.stored.tokens.access_token;
    } catch (error) {
      this.#logger.warn("Renewing a sign-in failed", {
        serverId: target.id,
        error: error instanceof Error ? error.message : String(error),
      });
      // A sign-in the service no longer accepts is over: it is recorded as
      // gone, so the connector asks for a new one instead of retrying forever.
      if (!provider.stored.tokens) {
        await this.#store.save(target.reference ?? null, `${target.name} sign-in`, JSON.stringify(provider.stored));
      }
      return null;
    }
  }

  async #read(reference: string | undefined): Promise<StoredSignIn> {
    if (!reference) {
      return {};
    }
    const text = await this.#store.load(reference);
    if (!text) {
      return {};
    }
    try {
      return JSON.parse(text) as StoredSignIn;
    } catch {
      return {};
    }
  }

  #provider(
    stored: StoredSignIn,
    flow: {
      redirectUrl: string;
      state: string;
      onRedirect: (url: URL) => void | Promise<void>;
      onVerifier: (value: string) => void;
      verifier: () => string;
    },
  ): OAuthClientProvider & { stored: StoredSignIn } {
    const clientName = this.#clientName;
    const holder = { stored: { ...stored } };
    const metadata: OAuthClientMetadata = {
      client_name: clientName,
      redirect_uris: [flow.redirectUrl],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    };
    return {
      get stored() {
        return holder.stored;
      },
      get redirectUrl() {
        return flow.redirectUrl;
      },
      get clientMetadata() {
        return metadata;
      },
      state: () => flow.state,
      clientInformation: () => holder.stored.client,
      saveClientInformation: (client) => {
        holder.stored = { ...holder.stored, client };
      },
      tokens: () => holder.stored.tokens,
      saveTokens: (tokens) => {
        holder.stored = {
          ...holder.stored,
          // A renewal may leave the refresh token out: the old one still holds.
          tokens: {
            ...tokens,
            ...(tokens.refresh_token || !holder.stored.tokens?.refresh_token
              ? {}
              : { refresh_token: holder.stored.tokens.refresh_token }),
          },
          obtainedAt: Date.now(),
        };
      },
      redirectToAuthorization: (url) => flow.onRedirect(url),
      saveCodeVerifier: (value) => flow.onVerifier(value),
      codeVerifier: () => flow.verifier(),
      discoveryState: () => holder.stored.discovery as never,
      saveDiscoveryState: (discovery) => {
        holder.stored = { ...holder.stored, discovery };
      },
      invalidateCredentials: (scope) => {
        if (scope === "all" || scope === "client") {
          if (!holder.stored.presetClient) {
            delete holder.stored.client;
          }
        }
        if (scope === "all" || scope === "tokens") {
          delete holder.stored.tokens;
        }
        if (scope === "all" || scope === "discovery") {
          delete holder.stored.discovery;
        }
      },
    };
  }
}

/**
 * A one-time listener on 127.0.0.1 for the service's redirect. It answers
 * the browser with a short page and hands over the code only when the state
 * matches the sign-in it was opened for.
 */
async function listenForCallback(): Promise<{
  url: string;
  code(state: string, timeoutMs: number): Promise<string>;
  close(): void;
}> {
  let deliver: ((result: { code?: string; state?: string; error?: string }) => void) | null = null;
  const early: Array<{ code?: string; state?: string; error?: string }> = [];
  const server: Server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (url.pathname !== "/callback") {
      response.writeHead(404).end();
      return;
    }
    const result = {
      ...(url.searchParams.get("code") ? { code: url.searchParams.get("code") ?? "" } : {}),
      ...(url.searchParams.get("state") !== null ? { state: url.searchParams.get("state") ?? "" } : {}),
      ...(url.searchParams.get("error")
        ? {
            error:
              url.searchParams.get("error_description") ?? url.searchParams.get("error") ?? "refused",
          }
        : {}),
    };
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(
      `<!doctype html><meta charset="utf-8"><title>AI Workbench</title><body style="font:15px system-ui;margin:3em;color:#333">${
        result.error ? "The sign-in was not completed. You can close this tab." : "Signed in. You can close this tab and go back to AI Workbench."
      }</body>`,
    );
    if (deliver) {
      deliver(result);
    } else {
      early.push(result);
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}/callback`,
    code: (state, timeoutMs) =>
      new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("The sign-in took too long. Try again.")), timeoutMs);
        deliver = (result) => {
          if (result.state !== state) {
            // Not the answer to this sign-in; keep waiting for the right one.
            return;
          }
          clearTimeout(timer);
          if (result.error || !result.code) {
            reject(new Error(`The sign-in was refused: ${result.error ?? "no code came back"}.`));
            return;
          }
          resolve(result.code);
        };
        for (const result of early.splice(0)) {
          deliver(result);
        }
      }),
    close: () => {
      server.close();
      server.closeAllConnections?.();
    },
  };
}
