import { randomBytes } from "node:crypto";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** What git is told when it asks for a user name or a password. */
export type AskpassAnswer = (prompt: string) => Promise<string | null>;

export interface Askpass {
  /** Variables for the one git run that may ask. */
  readonly env: Record<string, string>;
  close(): Promise<void>;
}

/**
 * The small program git runs to ask for a user name or password. It does
 * not hold the answer: it asks the application over a local channel that
 * exists for one git run and answers only whoever knows its random path.
 */
const HELPER = `"use strict";
const http = require("node:http");
const address = process.env.AI_WORKBENCH_ASKPASS_URL || "";
const prompt = process.argv[2] || "";
if (!address) process.exit(1);
http
  .get(address + "?prompt=" + encodeURIComponent(prompt), (response) => {
    let body = "";
    response.setEncoding("utf8");
    response.on("data", (chunk) => (body += chunk));
    response.on("end", () => {
      if (response.statusCode !== 200) process.exit(1);
      process.stdout.write(body + "\\n");
    });
  })
  .on("error", () => process.exit(1));
`;

/**
 * Git runs GIT_ASKPASS with the prompt as its argument. A shell script works
 * on every system git runs on — Git for Windows runs it with its own shell —
 * and starts the helper with the application's own runtime.
 */
const WRAPPER = `#!/bin/sh
ELECTRON_RUN_AS_NODE=1 exec "$AI_WORKBENCH_ASKPASS_NODE" "$AI_WORKBENCH_ASKPASS_MAIN" "$@"
`;

/**
 * Starts the channel for one git run. The answer is given only while it is
 * open, only on 127.0.0.1, and only to a request on the random path; the
 * secret itself is never written to disk, into the environment or into git's
 * configuration.
 */
export async function startAskpass(answer: AskpassAnswer): Promise<Askpass> {
  const folder = await mkdtemp(join(tmpdir(), "ai-workbench-askpass-"));
  const helper = join(folder, "askpass-main.cjs");
  const wrapper = join(folder, "askpass.sh");
  await writeFile(helper, HELPER, "utf8");
  await writeFile(wrapper, WRAPPER, "utf8");
  await chmod(wrapper, 0o700);

  const path = `/${randomBytes(24).toString("hex")}`;
  const server: Server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (request.method !== "GET" || url.pathname !== path) {
      response.writeHead(404).end();
      return;
    }
    void answer(url.searchParams.get("prompt") ?? "").then(
      (value) => {
        if (value === null) {
          response.writeHead(403).end();
          return;
        }
        response.writeHead(200, { "content-type": "text/plain; charset=utf-8" }).end(value);
      },
      () => response.writeHead(500).end(),
    );
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;

  return {
    env: {
      GIT_ASKPASS: wrapper,
      // Never fall back to asking on a terminal nobody sees.
      GIT_TERMINAL_PROMPT: "0",
      AI_WORKBENCH_ASKPASS_NODE: process.execPath,
      AI_WORKBENCH_ASKPASS_MAIN: helper,
      AI_WORKBENCH_ASKPASS_URL: `http://127.0.0.1:${port}${path}`,
    },
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(folder, { recursive: true, force: true });
    },
  };
}
