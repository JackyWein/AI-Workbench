import { execFileSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeTempDirectory, removeTempDirectory } from "@ai-workbench/test-support";
import type { Logger } from "@ai-workbench/shared";
import { GitCommandError, GitService } from "../service.js";

const logger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => logger,
};

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

/** A new repository with an identity of its own, so commits work anywhere. */
async function repository(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
  git(path, "init", "--quiet", "--initial-branch=main");
  git(path, "config", "user.name", "Check");
  git(path, "config", "user.email", "check@example.invalid");
  git(path, "config", "commit.gpgsign", "false");
  // Files stay as written, whatever the machine's own line-ending setting.
  git(path, "config", "core.autocrlf", "false");
}

describe("source control against a remote", () => {
  let root: string;
  let service: GitService;

  beforeEach(async () => {
    root = await makeTempDirectory("git-remote-");
    service = new GitService({ logger });
  });

  afterEach(async () => {
    await removeTempDirectory(root);
  });

  it("stages and unstages files, commits, pushes, pulls and starts a branch", async () => {
    const remote = join(root, "remote.git");
    git(root, "init", "--quiet", "--bare", "--initial-branch=main", remote);
    const work = join(root, "work");
    await repository(work);
    git(work, "remote", "add", "origin", remote);

    await writeFile(join(work, "notes.md"), "first\n");
    await writeFile(join(work, "draft.md"), "not yet\n");
    await service.stage(work, ["notes.md", "draft.md"]);
    // Before the first commit there is nothing to restore; unstaging still works.
    await service.unstage(work, ["draft.md"]);
    let status = await service.status(work);
    expect(status.changes.find((change) => change.path === "notes.md")?.staged).toBe(true);
    expect(status.changes.find((change) => change.path === "draft.md")?.staged).toBe(false);
    expect(await service.stagedDiff(work)).toContain("+first");

    const { commit } = await service.commit(work, "Add notes\n\nThe first line of them.");
    expect(commit).toMatch(/^[0-9a-f]{40}$/);
    expect(git(work, "log", "-1", "--format=%B").trim()).toBe("Add notes\n\nThe first line of them.");

    // A branch without upstream gets one on origin.
    await service.push(work);
    expect(git(remote, "rev-parse", "main").trim()).toBe(commit);
    status = await service.status(work);
    expect(status.upstream).toBe("origin/main");

    // Someone else pushes; pulling brings it in.
    const other = join(root, "other");
    git(root, "clone", "--quiet", remote, other);
    git(other, "config", "user.name", "Other");
    git(other, "config", "user.email", "other@example.invalid");
    await writeFile(join(other, "notes.md"), "first\nsecond\n");
    git(other, "commit", "--quiet", "-am", "More notes");
    git(other, "push", "--quiet");
    await service.pull(work);
    expect(await readFile(join(work, "notes.md"), "utf8")).toBe("first\nsecond\n");

    await service.createBranch(work, "feature/notes");
    expect((await service.status(work)).branch).toBe("feature/notes");
    await expect(service.createBranch(work, "bad name..")).rejects.toThrow(GitCommandError);

    // Staged changes after a commit are unstaged from HEAD.
    await writeFile(join(work, "notes.md"), "changed\n");
    await service.stage(work, ["notes.md"]);
    await service.unstage(work, ["notes.md"]);
    expect((await service.status(work)).changes.every((change) => !change.staged)).toBe(true);
    await expect(service.commit(work, "   ")).rejects.toThrow(/needs a message/);
  });

  it("hands a remote its credentials through askpass and keeps them nowhere", async () => {
    const token = "ghs_standin0123456789abcdefghijklmnopqrstuv";
    const served = join(root, "served");
    git(root, "init", "--quiet", "--bare", "--initial-branch=main", join(served, "repo.git"));
    const server = await gitHttpServer(served, token);
    try {
      const work = join(root, "work");
      await repository(work);
      git(work, "remote", "add", "origin", `${server.url}/repo.git`);
      // A credential helper the person configured must not end up holding
      // the application's token.
      const stored = join(root, "stored-credentials");
      git(work, "config", "credential.helper", `store --file=${stored.replace(/\\/g, "/")}`);
      await writeFile(join(work, "a.txt"), "a\n");
      await service.stage(work, ["a.txt"]);
      const { commit } = await service.commit(work, "Add a");

      // Without credentials the remote refuses, and git does not hang asking.
      await expect(service.push(work)).rejects.toThrow(GitCommandError);

      const asked: string[] = [];
      await service.push(work, {
        credentials: async (url) => {
          asked.push(url);
          return { username: "x-access-token", password: token };
        },
      });
      expect(asked).toEqual([`${server.url}/repo.git`]);
      expect(git(join(served, "repo.git"), "rev-parse", "main").trim()).toBe(commit);
      expect(server.authorized()).toBeGreaterThan(0);

      const config = await readFile(join(work, ".git", "config"), "utf8");
      expect(config).not.toContain(token);
      expect(git(work, "remote", "get-url", "origin")).not.toContain(token);
      expect(existsSync(stored) ? await readFile(stored, "utf8") : "").not.toContain(token);

      // Pulling uses the same way in.
      await service.pull(work, { credentials: async () => ({ username: "x-access-token", password: token }) });
    } finally {
      await server.close();
    }
  });
});

/**
 * A git remote over HTTP that wants a token, served by git's own
 * http-backend — the same protocol GitHub speaks for https remotes.
 */
async function gitHttpServer(
  projectRoot: string,
  token: string,
): Promise<{ url: string; authorized: () => number; close: () => Promise<void> }> {
  let authorized = 0;
  const expected = `Basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`;
  const server: Server = createServer((request: IncomingMessage, response: ServerResponse) => {
    if (request.headers.authorization !== expected) {
      response.writeHead(401, { "WWW-Authenticate": 'Basic realm="stand-in"' }).end();
      return;
    }
    authorized += 1;
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const child = spawn("git", ["http-backend"], {
      env: {
        ...process.env,
        GIT_PROJECT_ROOT: projectRoot,
        GIT_HTTP_EXPORT_ALL: "1",
        PATH_INFO: url.pathname,
        QUERY_STRING: url.search.slice(1),
        REQUEST_METHOD: request.method ?? "GET",
        CONTENT_TYPE: request.headers["content-type"] ?? "",
        ...(request.headers["content-length"] ? { CONTENT_LENGTH: request.headers["content-length"] } : {}),
        ...(request.headers["content-encoding"] ? { HTTP_CONTENT_ENCODING: request.headers["content-encoding"] } : {}),
        ...(request.headers["git-protocol"] ? { GIT_PROTOCOL: String(request.headers["git-protocol"]) } : {}),
        REMOTE_USER: "x-access-token",
        REMOTE_ADDR: "127.0.0.1",
      },
    });
    request.pipe(child.stdin);
    let head = Buffer.alloc(0);
    let started = false;
    child.stdout.on("data", (chunk: Buffer) => {
      if (started) {
        response.write(chunk);
        return;
      }
      head = Buffer.concat([head, chunk]);
      const end = head.indexOf("\r\n\r\n");
      if (end === -1) {
        return;
      }
      let status = 200;
      const headers: Record<string, string> = {};
      for (const line of head.subarray(0, end).toString("utf8").split("\r\n")) {
        const colon = line.indexOf(":");
        const name = line.slice(0, colon).trim();
        const value = line.slice(colon + 1).trim();
        if (name.toLowerCase() === "status") {
          status = Number.parseInt(value, 10);
        } else if (name) {
          headers[name] = value;
        }
      }
      response.writeHead(status, headers);
      started = true;
      const rest = head.subarray(end + 4);
      if (rest.length > 0) {
        response.write(rest);
      }
    });
    child.stdout.on("end", () => response.end());
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return {
    url: `http://127.0.0.1:${port}`,
    authorized: () => authorized,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
