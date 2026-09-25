import { createServer, type IncomingMessage, type Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CredentialManager, InMemoryCredentialStorage, InMemoryEncryption } from "@ai-workbench/credentials";
import { GitHubError, GitHubService, parseRepository } from "../github-service.js";
import { createNullLogger } from "../logger.js";

const TOKEN = "gho_standin0123456789abcdefghijklmnopqrstu";

interface Recorded {
  readonly method: string;
  readonly path: string;
  readonly authorization: string | undefined;
  readonly body: Record<string, unknown>;
}

/** GitHub as far as the application uses it: device flow, /user, repos and pulls. */
async function standInGitHub(): Promise<{ base: string; requests: Recorded[]; close(): Promise<void> }> {
  const requests: Recorded[] = [];
  let polls = 0;
  const server: Server = createServer((request: IncomingMessage, response) => {
    let raw = "";
    request.on("data", (chunk: Buffer) => (raw += chunk.toString("utf8")));
    request.on("end", () => {
      const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
      const path = request.url ?? "/";
      requests.push({ method: request.method ?? "GET", path, authorization: request.headers.authorization, body });
      const reply = (status: number, value: unknown): void => {
        response.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(value));
      };
      if (path === "/login/device/code") {
        reply(200, {
          device_code: "device-123",
          user_code: "WDJB-MJHT",
          verification_uri: "https://github.example/login/device",
          expires_in: 60,
          interval: 0,
        });
      } else if (path === "/login/oauth/access_token") {
        polls += 1;
        reply(200, polls < 2 ? { error: "authorization_pending" } : { access_token: TOKEN, token_type: "bearer" });
      } else if (path === "/api/user") {
        if (request.headers.authorization === `Bearer ${TOKEN}`) {
          reply(200, { login: "octo-person" });
        } else {
          reply(401, { message: "Bad credentials" });
        }
      } else if (path === "/api/repos/octo-person/notes" && request.method === "GET") {
        reply(200, { default_branch: "trunk" });
      } else if (path === "/api/repos/octo-person/notes/pulls" && request.method === "POST") {
        reply(201, { number: 7, html_url: "https://github.example/octo-person/notes/pull/7" });
      } else {
        reply(404, { message: "Not Found" });
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return {
    base: `http://127.0.0.1:${port}`,
    requests,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

describe("the GitHub connection", () => {
  let github: Awaited<ReturnType<typeof standInGitHub>>;
  let credentials: CredentialManager;
  let service: GitHubService;

  beforeEach(async () => {
    github = await standInGitHub();
    credentials = new CredentialManager({
      encryption: new InMemoryEncryption(),
      storage: new InMemoryCredentialStorage(),
      logger: createNullLogger(),
    });
    service = new GitHubService({
      credentials,
      logger: createNullLogger(),
      endpoints: { api: `${github.base}/api`, web: github.base, clientId: "Iv1.standin" },
    });
  });

  afterEach(async () => {
    await service.signOut();
    await github.close();
  });

  it("signs in through the device flow and keeps only a reference for the window", async () => {
    const started = await service.startDeviceFlow();
    expect(started.pending).toMatchObject({ userCode: "WDJB-MJHT", verificationUri: "https://github.example/login/device" });
    expect(started.connected).toBe(false);

    let status = await service.status();
    for (let attempt = 0; attempt < 100 && !status.connected; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      status = await service.status();
    }
    expect(status).toMatchObject({ connected: true, login: "octo-person", pending: null, error: null });
    // What the window gets names the person, never the token.
    expect(JSON.stringify(status)).not.toContain(TOKEN);
    expect((await credentials.list()).map((entry) => entry.kind)).toEqual(["github"]);
    const poll = github.requests.find((request) => request.path === "/login/oauth/access_token");
    expect(poll?.body).toMatchObject({ client_id: "Iv1.standin", device_code: "device-123" });
  });

  it("connects with a token after checking it, and refuses one GitHub does not accept", async () => {
    await expect(service.signInWithToken("gho_wrong")).rejects.toThrow(GitHubError);
    expect((await service.status()).connected).toBe(false);
    const status = await service.signInWithToken(`  ${TOKEN}\n`);
    expect(status).toMatchObject({ connected: true, login: "octo-person" });
    expect(JSON.stringify(status)).not.toContain(TOKEN);
  });

  it("gives git the token for its own remotes only", async () => {
    expect(await service.credentialsFor(`${github.base}/octo-person/notes.git`)).toBeNull();
    await service.signInWithToken(TOKEN);
    expect(await service.credentialsFor(`${github.base}/octo-person/notes.git`)).toEqual({
      username: "x-access-token",
      password: TOKEN,
    });
    expect(await service.credentialsFor("https://gitlab.example/octo-person/notes.git")).toBeNull();
    await service.signOut();
    expect(await service.credentialsFor(`${github.base}/octo-person/notes.git`)).toBeNull();
  });

  it("opens a pull request into the repository's default branch", async () => {
    await service.signInWithToken(TOKEN);
    const opened = await service.openPullRequest({
      remoteUrl: `${github.base}/octo-person/notes.git`,
      head: "feature/notes",
      title: "Add notes",
      body: "What and why.",
    });
    expect(opened).toEqual({ number: 7, url: "https://github.example/octo-person/notes/pull/7" });
    const created = github.requests.find((request) => request.path.endsWith("/pulls"));
    expect(created?.authorization).toBe(`Bearer ${TOKEN}`);
    expect(created?.body).toEqual({ title: "Add notes", head: "feature/notes", base: "trunk", body: "What and why." });
  });

  it("says so when the build has no GitHub app for the device flow", async () => {
    service.useEndpoints({ clientId: null });
    expect((await service.status()).deviceFlowAvailable).toBe(false);
    await expect(service.startDeviceFlow()).rejects.toThrow(/token instead/);
  });
});

describe("reading a GitHub remote", () => {
  it("understands https, scp-like and ssh remotes, and nothing on another host", () => {
    const web = "https://github.com";
    expect(parseRepository("https://github.com/octo/notes.git", web)).toEqual({ owner: "octo", name: "notes" });
    expect(parseRepository("git@github.com:octo/notes.git", web)).toEqual({ owner: "octo", name: "notes" });
    expect(parseRepository("ssh://git@github.com/octo/notes", web)).toEqual({ owner: "octo", name: "notes" });
    expect(parseRepository("https://gitlab.com/octo/notes.git", web)).toBeNull();
    expect(parseRepository("/srv/git/notes.git", web)).toBeNull();
  });
});
