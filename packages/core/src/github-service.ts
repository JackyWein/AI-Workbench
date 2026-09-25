import type { GitHubStatus, Logger } from "@ai-workbench/shared";

/** The part of the credential store GitHub needs; the secret never leaves main. */
export interface GitHubCredentialStore {
  store(input: { label: string; kind: string; secret: string; reference?: string }): Promise<unknown>;
  resolve(reference: string): Promise<string | null>;
  delete(reference: string): Promise<boolean>;
  list(): Promise<ReadonlyArray<{ readonly reference: string; readonly label: string; readonly kind: string }>>;
}

export interface GitHubEndpoints {
  /** The REST API, e.g. https://api.github.com. */
  readonly api: string;
  /** The website, where the device flow and repositories live, e.g. https://github.com. */
  readonly web: string;
  /**
   * The OAuth app the device flow signs in with. Without one only a token
   * can connect: the app must be registered by whoever ships the build.
   */
  readonly clientId: string | null;
}

export interface GitHubServiceOptions {
  readonly credentials: GitHubCredentialStore;
  readonly logger: Logger;
  readonly endpoints?: Partial<GitHubEndpoints>;
  readonly fetch?: typeof fetch;
}

export class GitHubError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GitHubError";
  }
}

/** The one GitHub connection; its token lives in the credential store under this reference. */
const REFERENCE = "github-account";
const KIND = "github";

/** What the device flow asks for: repositories, to push and open pull requests. */
const SCOPE = "repo";

interface PendingDeviceFlow {
  readonly userCode: string;
  readonly verificationUri: string;
  readonly expiresAt: Date;
}

/**
 * The person's GitHub connection (FutureFeatures 2): signing in by the
 * device flow or with a token, the credentials git gets for GitHub remotes,
 * and pull requests. The token stays in the credential store; the window
 * only ever learns who is connected.
 */
export class GitHubService {
  readonly #credentials: GitHubCredentialStore;
  readonly #logger: Logger;
  readonly #fetch: typeof fetch;
  #endpoints: GitHubEndpoints;
  #pending: PendingDeviceFlow | null = null;
  #error: string | null = null;
  #polling: AbortController | null = null;

  constructor(options: GitHubServiceOptions) {
    this.#credentials = options.credentials;
    this.#logger = options.logger.child("PLUGIN");
    this.#fetch = options.fetch ?? fetch;
    this.#endpoints = {
      api: options.endpoints?.api ?? "https://api.github.com",
      web: options.endpoints?.web ?? "https://github.com",
      clientId: options.endpoints?.clientId ?? null,
    };
  }

  /** Points the service at another GitHub (a stand-in, or GitHub Enterprise). Main process only. */
  useEndpoints(endpoints: Partial<GitHubEndpoints>): void {
    this.#endpoints = { ...this.#endpoints, ...endpoints };
  }

  async status(): Promise<GitHubStatus> {
    const stored = (await this.#credentials.list()).find(
      (entry) => entry.reference === REFERENCE && entry.kind === KIND,
    );
    return {
      connected: Boolean(stored),
      login: stored?.label ?? null,
      deviceFlowAvailable: this.#endpoints.clientId !== null,
      pending: this.#pending
        ? {
            userCode: this.#pending.userCode,
            verificationUri: this.#pending.verificationUri,
            expiresAt: this.#pending.expiresAt,
          }
        : null,
      error: this.#error,
    };
  }

  /** Connects with a token the person created on GitHub; it is checked first. */
  async signInWithToken(token: string): Promise<GitHubStatus> {
    const value = token.trim();
    if (!value) {
      throw new GitHubError("Paste a GitHub token.");
    }
    const login = await this.#whoIs(value);
    await this.#keep(value, login);
    return this.status();
  }

  /**
   * Starts GitHub's device flow: the person opens the page, types the code,
   * and the connection completes in the background.
   */
  async startDeviceFlow(): Promise<GitHubStatus> {
    const clientId = this.#endpoints.clientId;
    if (!clientId) {
      throw new GitHubError("Signing in through GitHub needs this build's GitHub app. Connect with a token instead.");
    }
    this.#polling?.abort();
    this.#error = null;
    const response = await this.#fetch(`${this.#endpoints.web}/login/device/code`, {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify({ client_id: clientId, scope: SCOPE }),
    });
    const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    const deviceCode = typeof body["device_code"] === "string" ? body["device_code"] : null;
    const userCode = typeof body["user_code"] === "string" ? body["user_code"] : null;
    const verificationUri = typeof body["verification_uri"] === "string" ? body["verification_uri"] : null;
    if (!response.ok || !deviceCode || !userCode || !verificationUri) {
      throw new GitHubError(describeFailure(body, "GitHub did not start the sign-in."));
    }
    const expiresIn = typeof body["expires_in"] === "number" ? body["expires_in"] : 900;
    const interval = typeof body["interval"] === "number" ? body["interval"] : 5;
    this.#pending = { userCode, verificationUri, expiresAt: new Date(Date.now() + expiresIn * 1000) };
    const polling = new AbortController();
    this.#polling = polling;
    void this.#poll(clientId, deviceCode, interval, polling.signal);
    return this.status();
  }

  async signOut(): Promise<GitHubStatus> {
    this.#polling?.abort();
    this.#pending = null;
    this.#error = null;
    await this.#credentials.delete(REFERENCE);
    return this.status();
  }

  /**
   * What git is given for a remote on this GitHub: the token as password.
   * Null for any other host, or when nobody is connected. Main process only.
   */
  async credentialsFor(remoteUrl: string): Promise<{ username: string; password: string } | null> {
    if (!parseRepository(remoteUrl, this.#endpoints.web)) {
      return null;
    }
    const token = await this.#credentials.resolve(REFERENCE);
    return token ? { username: "x-access-token", password: token } : null;
  }

  /** Opens a pull request from `head` into `base` (or the repository's default branch). */
  async openPullRequest(input: {
    readonly remoteUrl: string;
    readonly head: string;
    readonly base?: string;
    readonly title: string;
    readonly body?: string;
  }): Promise<{ number: number; url: string }> {
    const repository = parseRepository(input.remoteUrl, this.#endpoints.web);
    if (!repository) {
      throw new GitHubError("This repository's remote is not on GitHub.");
    }
    const token = await this.#credentials.resolve(REFERENCE);
    if (!token) {
      throw new GitHubError("Connect GitHub first.");
    }
    const path = `/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.name)}`;
    let base = input.base;
    if (!base) {
      const about = await this.#api(token, path);
      base = typeof about["default_branch"] === "string" ? about["default_branch"] : "main";
    }
    const created = await this.#api(token, `${path}/pulls`, {
      title: input.title,
      head: input.head,
      base,
      ...(input.body ? { body: input.body } : {}),
    });
    const number = created["number"];
    const url = created["html_url"];
    if (typeof number !== "number" || typeof url !== "string") {
      throw new GitHubError("GitHub did not open the pull request.");
    }
    return { number, url };
  }

  async #poll(clientId: string, deviceCode: string, interval: number, signal: AbortSignal): Promise<void> {
    let wait = interval;
    while (!signal.aborted && this.#pending && Date.now() < this.#pending.expiresAt.getTime()) {
      await sleep(wait * 1000, signal);
      if (signal.aborted) {
        return;
      }
      try {
        const response = await this.#fetch(`${this.#endpoints.web}/login/oauth/access_token`, {
          method: "POST",
          headers: { accept: "application/json", "content-type": "application/json" },
          body: JSON.stringify({
            client_id: clientId,
            device_code: deviceCode,
            grant_type: "urn:ietf:params:oauth:grant-type:device_code",
          }),
          signal,
        });
        const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
        const token = typeof body["access_token"] === "string" ? body["access_token"] : null;
        if (token) {
          await this.#keep(token, await this.#whoIs(token));
          this.#pending = null;
          return;
        }
        const error = body["error"];
        if (error === "authorization_pending") {
          continue;
        }
        if (error === "slow_down") {
          wait += 5;
          continue;
        }
        this.#error = describeFailure(body, "GitHub did not complete the sign-in.");
        this.#pending = null;
        return;
      } catch (caught) {
        if (signal.aborted) {
          return;
        }
        this.#logger.warn("GitHub sign-in poll failed", {
          error: caught instanceof Error ? caught.message : String(caught),
        });
      }
    }
    if (this.#pending && !signal.aborted) {
      this.#error = "The code expired before it was entered. Start again.";
      this.#pending = null;
    }
  }

  async #whoIs(token: string): Promise<string> {
    const user = await this.#api(token, "/user");
    const login = user["login"];
    if (typeof login !== "string" || !login) {
      throw new GitHubError("GitHub did not accept this token.");
    }
    return login;
  }

  async #keep(token: string, login: string): Promise<void> {
    await this.#credentials.store({ reference: REFERENCE, kind: KIND, label: login, secret: token });
    this.#error = null;
    this.#logger.info("GitHub connected", { login });
  }

  async #api(token: string, path: string, body?: Record<string, unknown>): Promise<Record<string, unknown>> {
    const response = await this.#fetch(`${this.#endpoints.api}${path}`, {
      method: body ? "POST" : "GET",
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${token}`,
        "x-github-api-version": "2022-11-28",
        ...(body ? { "content-type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const parsed = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    if (!response.ok) {
      throw new GitHubError(
        response.status === 401
          ? "GitHub did not accept this token."
          : describeFailure(parsed, `GitHub answered ${response.status}.`),
      );
    }
    return parsed;
  }
}

/**
 * Owner and name of a repository whose remote is on the given GitHub:
 * https://github.com/owner/name(.git), git@github.com:owner/name.git or
 * ssh://git@github.com/owner/name.git. Null for any other host.
 */
export function parseRepository(remoteUrl: string, web: string): { owner: string; name: string } | null {
  let host: string;
  try {
    host = new URL(web).host.toLowerCase();
  } catch {
    return null;
  }
  const url = remoteUrl.trim();
  let path: string | null = null;
  const scp = /^[\w.-]+@([^:/]+):(.+)$/.exec(url);
  if (scp?.[1] && scp[2] && !url.includes("://")) {
    path = scp[1].toLowerCase() === host.split(":")[0] ? scp[2] : null;
  } else {
    try {
      const parsed = new URL(url);
      const sameHost =
        parsed.protocol === "ssh:" ? parsed.hostname.toLowerCase() === host.split(":")[0] : parsed.host.toLowerCase() === host;
      path = sameHost ? parsed.pathname : null;
    } catch {
      return null;
    }
  }
  const parts = path?.replace(/^\/+/, "").replace(/\.git$/, "").split("/") ?? [];
  const [owner, name] = parts;
  return parts.length === 2 && owner && name ? { owner, name } : null;
}

function describeFailure(body: Record<string, unknown>, fallback: string): string {
  const message = body["error_description"] ?? body["message"];
  return typeof message === "string" && message ? message : fallback;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}
