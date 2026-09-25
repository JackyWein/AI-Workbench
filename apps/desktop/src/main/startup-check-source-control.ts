import { createServer, type Server } from "node:http";
import { rm, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { execCli } from "@ai-workbench/transport-cli";
import type { GitHubService } from "@ai-workbench/core";

type Check = (name: string, script: string, timeoutMs?: number) => Promise<boolean>;
type CheckMain = (name: string, run: () => boolean | Promise<boolean>) => Promise<boolean>;

/** The token the stand-in GitHub hands out; the window must never see it. */
const CHECK_TOKEN = "gho_startupcheck0123456789abcdefghijklmn";

interface StandIn {
  readonly base: string;
  readonly pulls: Array<{ authorization: string | undefined; body: Record<string, unknown> }>;
  close(): Promise<void>;
}

/** GitHub as far as the application uses it, on 127.0.0.1. */
async function standInGitHub(): Promise<StandIn> {
  const pulls: StandIn["pulls"] = [];
  let polls = 0;
  let base = "";
  const server: Server = createServer((request, response) => {
    let raw = "";
    request.on("data", (chunk: Buffer) => (raw += chunk.toString("utf8")));
    request.on("end", () => {
      const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
      const reply = (status: number, value: unknown): void => {
        response.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(value));
      };
      const path = request.url ?? "/";
      if (path === "/login/device/code") {
        // Not https, so nothing opens a browser during the check.
        reply(200, { device_code: "check-device", user_code: "CHEC-K123", verification_uri: `${base}/login/device`, expires_in: 120, interval: 1 });
      } else if (path === "/login/oauth/access_token") {
        polls += 1;
        reply(200, polls < 2 ? { error: "authorization_pending" } : { access_token: CHECK_TOKEN });
      } else if (path === "/api/user") {
        reply(request.headers.authorization === `Bearer ${CHECK_TOKEN}` ? 200 : 401, { login: "check-person" });
      } else if (path === "/api/repos/check-person/notes" && request.method === "GET") {
        reply(200, { default_branch: "main" });
      } else if (path === "/api/repos/check-person/notes/pulls" && request.method === "POST") {
        pulls.push({ authorization: request.headers.authorization, body });
        reply(201, { number: 7, html_url: `${base}/check-person/notes/pull/7` });
      } else {
        reply(404, { message: "Not Found" });
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  base = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
  return {
    base,
    pulls,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout, exit } = await execCli({ executablePath: "git", args, cwd, timeoutMs: 20_000 });
  if (exit.code !== 0) {
    throw new Error(`git ${args.join(" ")}: ${exit.stderr.trim()}`);
  }
  return stdout.trim();
}

async function repository(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
  await git(path, "init", "--quiet", "--initial-branch=main");
  await git(path, "config", "user.name", "Startup check");
  await git(path, "config", "user.email", "check@example.invalid");
  await git(path, "config", "commit.gpgsign", "false");
}

/**
 * FutureFeatures 2 end to end, through the window: GitHub connected by the
 * device flow against a stand-in, files staged by ticking them, a message
 * suggested by the session's model, commit, push and pull against a local
 * remote, a commit with a likely secret stopped, a new branch and a pull
 * request.
 */
export async function checkSourceControl(options: {
  readonly check: Check;
  readonly checkMain: CheckMain;
  readonly waitFor: (condition: string, timeoutMs?: number) => string;
  readonly github: GitHubService;
  readonly folder: string;
}): Promise<void> {
  const { check, checkMain, waitFor, github, folder } = options;
  const remote = join(folder, "remote.git");
  const work = join(folder, "work");
  const other = join(folder, "other");
  let prepared = false;
  const gitHub = await standInGitHub();
  try {
    try {
      await rm(folder, { recursive: true, force: true });
      await mkdir(folder, { recursive: true });
      await git(folder, "init", "--quiet", "--bare", "--initial-branch=main", remote);
      await repository(work);
      await writeFile(join(work, "notes.md"), "# Notes\n");
      await git(work, "add", "notes.md");
      await git(work, "commit", "--quiet", "-m", "Start notes");
      await git(work, "remote", "add", "origin", remote);
      await git(work, "push", "--quiet", "--set-upstream", "origin", "main");
      github.useEndpoints({ api: `${gitHub.base}/api`, web: gitHub.base, clientId: "Iv1.startupcheck" });
      prepared = true;
    } catch {
      prepared = false;
    }
    if (!(await checkMain("a repository with a remote is ready for source control", () => prepared))) {
      return;
    }

    const openSession = `
      const api = window.workbench;
      const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
      const workspace = (await api.invoke('workspace.list', undefined)).find(entry => entry.path === ${JSON.stringify(work)})
        ?? await api.invoke('workspace.create', { name: 'Source space', path: ${JSON.stringify(work)} });
      const session = (await api.invoke('session.list', { workspaceId: workspace.id })).find(entry => entry.name === 'Source session')
        ?? await api.invoke('session.create', { workspaceId: workspace.id, name: 'Source session', type: 'solo', providerId: 'mock' });
      window.__sourceSessionId = session.id;
      const rows = () => [...document.querySelectorAll('.sidebar__scroll .row')];
      rows().find(node => node.textContent?.includes('Source space'))?.click();
      await sleep(500);
      rows().find(node => node.querySelector('.row__text')?.textContent === 'Source session')?.click();
      await sleep(500);
      [...document.querySelectorAll('.panel__tab')].find(node => node.textContent?.startsWith('Changes'))?.click();
      await sleep(400);
      const refresh = async () => {
        [...document.querySelectorAll('.changes__actions .quiet-button')].find(node => node.textContent?.includes('Refresh'))?.click();
        await sleep(500);
      };
      const tick = async (path) => {
        const box = document.querySelector('.changes__stage[aria-label="Stage ' + path + '"]');
        box?.click();
        return ${waitFor("document.querySelector('.changes__stage[aria-label=\"Unstage ' + path + '\"]')?.checked", 4000)};
      };
      const type = (element, value) => {
        const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), 'value').set;
        setter.call(element, value);
        element.dispatchEvent(new Event('input', { bubbles: true }));
      };
      const button = (text) => [...document.querySelectorAll('.changes button')].find(node => node.textContent?.trim() === text);
    `;

    await check(
      "GitHub connects through the device flow, and the window only learns who",
      `(async () => {
         const api = window.workbench;
         [...document.querySelectorAll('.sidebar__foot .row')].find(row => row.textContent?.includes('Settings'))?.click();
         await new Promise(resolve => setTimeout(resolve, 400));
         const start = [...document.querySelectorAll('button')].find(node => node.textContent === 'Sign in with GitHub');
         if (!start) return 'no way to sign in with GitHub';
         start.click();
         const code = await ${waitFor("document.querySelector('.github-code')?.textContent === 'CHEC-K123'", 4000)};
         if (!code) return 'the code to enter on GitHub is not shown';
         const connected = await ${waitFor("document.body.textContent?.includes('Connected as check-person')", 10000)};
         if (!connected) return 'the sign-in did not complete';
         const status = await api.invoke('github.status', undefined);
         if (JSON.stringify(status).includes(${JSON.stringify(CHECK_TOKEN)}) || document.body.innerHTML.includes(${JSON.stringify(CHECK_TOKEN)})) {
           return 'the token reached the window';
         }
         return status.connected && status.login === 'check-person';
       })()`,
      20_000,
    );

    await check(
      "files are staged by ticking them, the model suggests the message, and the commit is pushed",
      `(async () => {
         ${openSession}
         await api.invoke('files.write', { sessionId: session.id, path: 'notes.md', content: '# Notes\\n\\nA line from the check.\\n' });
         await refresh();
         if (!(await tick('notes.md'))) return 'ticking the file did not stage it';
         button('Suggest')?.click();
         const suggested = await ${waitFor("document.querySelector('.changes__message')?.value?.startsWith('Update notes.md')", 10000)};
         if (!suggested) return 'no message from the model: ' + document.querySelector('.changes__message')?.value;
         button('Commit')?.click();
         let status = null;
         for (let attempt = 0; attempt < 40; attempt += 1) {
           await sleep(200);
           status = await api.invoke('git.status', { sessionId: session.id });
           if (status.clean && status.ahead === 1) break;
         }
         if (!status?.clean || status.ahead !== 1) return 'the commit did not happen: ' + JSON.stringify(status);
         await refresh();
         button('Push')?.click();
         for (let attempt = 0; attempt < 40; attempt += 1) {
           await sleep(200);
           status = await api.invoke('git.status', { sessionId: session.id });
           if (status.ahead === 0) return true;
         }
         return 'the push did not go through';
       })()`,
      40_000,
    );

    await checkMain("the pushed commit is on the remote, with the suggested message", async () => {
      const [pushed, head] = await Promise.all([git(remote, "rev-parse", "main"), git(work, "rev-parse", "HEAD")]);
      const subject = await git(remote, "log", "-1", "--format=%s", "main");
      // Someone else adds to the remote, for the pull that follows.
      await git(folder, "clone", "--quiet", remote, other);
      await git(other, "config", "user.name", "Someone else");
      await git(other, "config", "user.email", "else@example.invalid");
      await writeFile(join(other, "later.md"), "From someone else.\n");
      await git(other, "add", "later.md");
      await git(other, "commit", "--quiet", "-m", "Add a note from someone else");
      await git(other, "push", "--quiet");
      return pushed === head && subject === "Update notes.md";
    });

    await check(
      "pull brings in what someone else pushed",
      `(async () => {
         ${openSession}
         button('Pull')?.click();
         for (let attempt = 0; attempt < 40; attempt += 1) {
           await sleep(200);
           const read = await api.invoke('files.read', { sessionId: session.id, path: 'later.md' }).catch(() => null);
           if (read?.content?.includes('From someone else')) return true;
         }
         return 'the pull did not bring the new file';
       })()`,
      20_000,
    );

    await check(
      "a commit holding a likely secret is stopped and says what it found",
      `(async () => {
         ${openSession}
         const fake = 'ghp_' + 'Ab12Cd34Ef'.repeat(4);
         await api.invoke('files.write', { sessionId: session.id, path: 'secret.ts', content: 'export const token = "' + fake + '";\\n' });
         await refresh();
         if (!(await tick('secret.ts'))) return 'ticking the file did not stage it';
         type(document.querySelector('.changes__message'), 'Add the token');
         button('Commit')?.click();
         const stopped = await ${waitFor("document.querySelector('.changes__findings')?.textContent?.includes('GitHub token in secret.ts:1')", 6000)};
         if (!stopped) return 'no finding shown: ' + (document.querySelector('.changes')?.textContent ?? '');
         if (document.querySelector('.changes__findings')?.textContent?.includes(fake)) return 'the finding repeats the secret';
         const status = await api.invoke('git.status', { sessionId: session.id });
         if (status.ahead !== 0) return 'it was committed anyway';
         button('Go back')?.click();
         // Taken out again, so the next check starts clean.
         document.querySelector('.changes__stage[aria-label="Unstage secret.ts"]')?.click();
         return ${waitFor("document.querySelector('.changes__stage[aria-label=\"Stage secret.ts\"]')", 4000)};
       })()`,
      20_000,
    );

    await check(
      "a new branch is created, pushed, and a pull request is opened for it",
      `(async () => {
         ${openSession}
         button('New branch')?.click();
         await sleep(200);
         type(document.querySelector('input[aria-label="New branch name"]'), 'feature/check');
         [...document.querySelectorAll('.changes__branch-form button')].find(node => node.textContent === 'Create and switch')?.click();
         const switched = await ${waitFor("document.querySelector('.changes__branch')?.textContent === 'feature/check'", 5000)};
         if (!switched) return 'the branch was not created';
         await api.invoke('files.write', { sessionId: session.id, path: 'notes.md', content: '# Notes\\n\\nOn a branch.\\n' });
         await refresh();
         if (!(await tick('notes.md'))) return 'ticking the file did not stage it';
         type(document.querySelector('.changes__message'), 'Work on a branch');
         button('Commit')?.click();
         await sleep(800);
         button('Push')?.click();
         for (let attempt = 0; attempt < 40; attempt += 1) {
           await sleep(200);
           const status = await api.invoke('git.status', { sessionId: session.id });
           if (status.upstream === 'origin/feature/check' && status.ahead === 0) return true;
         }
         return 'the branch was not pushed';
       })()`,
      30_000,
    );

    await checkMain("the remote now points at the stand-in GitHub", async () => {
      await git(work, "remote", "set-url", "origin", `${gitHub.base}/check-person/notes.git`);
      return true;
    });

    await check(
      "the pull request reaches GitHub from the panel",
      `(async () => {
         ${openSession}
         await refresh();
         const open = await ${waitFor("[...document.querySelectorAll('.changes__pr button')].find(node => node.textContent?.includes('Open pull request for feature/check'))", 5000)};
         if (!open) return 'no way to open a pull request';
         [...document.querySelectorAll('.changes__pr button')].find(node => node.textContent?.includes('Open pull request for feature/check'))?.click();
         await sleep(200);
         type(document.querySelector('input[aria-label="Pull request title"]'), 'Work on a branch');
         [...document.querySelectorAll('.changes__pr--open button')].find(node => node.textContent === 'Open pull request')?.click();
         return await ${waitFor("document.querySelector('.changes__pr a')?.textContent === '#7 opened'", 6000)} || 'the pull request was not opened';
       })()`,
      20_000,
    );

    await checkMain("GitHub got the pull request with the connected account's token", () => {
      const pull = gitHub.pulls[0];
      return (
        gitHub.pulls.length === 1 &&
        pull?.authorization === `Bearer ${CHECK_TOKEN}` &&
        pull.body["head"] === "feature/check" &&
        pull.body["base"] === "main" &&
        pull.body["title"] === "Work on a branch"
      );
    });

    await check(
      "GitHub is disconnected again",
      `(async () => {
         const api = window.workbench;
         const status = await api.invoke('github.signOut', undefined);
         const session = window.__sourceSessionId;
         if (session) await api.invoke('session.delete', { id: session }).catch(() => {});
         // Back to the session the checks after these work in.
         const rows = () => [...document.querySelectorAll('.sidebar__scroll .row')];
         rows().find(node => node.textContent?.includes('Check workspace'))?.click();
         await new Promise(resolve => setTimeout(resolve, 500));
         rows().find(node => node.querySelector('.row__text')?.textContent === 'Check session')?.click();
         await new Promise(resolve => setTimeout(resolve, 400));
         return !status.connected;
       })()`,
    );
  } finally {
    await gitHub.close();
  }
}
