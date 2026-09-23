import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import {
  OpencodeServerLink,
  OpencodeServerState,
  answerRequest,
  argsForOpencode2,
  mergeOpencodeModels,
  parseOpencodeLine,
  parseOpencodeModels,
  parseMajor,
  parseStatsTable,
  statsLimits,
} from "../index.js";

const fixture = (name: string): string =>
  readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");

/** Events recorded from OpenCode 1.18.32's own server, one per line. */
const events = (name: string): unknown[] =>
  fixture(name)
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as unknown);

describe("OpenCode's run output", () => {
  it("reads a recorded turn with a tool call: session, call, answer and summed usage", () => {
    const state = { values: new Map<string, unknown>() };
    const parsed = fixture("run-tool.jsonl")
      .trim()
      .split("\n")
      .flatMap((line) => parseOpencodeLine(line, state));
    expect(parsed.filter((event) => event.type === "session")).toHaveLength(1);
    const result = parsed.find((event) => event.type === "tool_result");
    expect(result).toMatchObject({
      toolCall: {
        name: "bash",
        summary: "touch opencode-allowed.txt",
        input: { command: "touch opencode-allowed.txt" },
        output: "(no output)",
        state: "completed",
      },
    });
    expect(parsed.filter((event) => event.type === "text_delta")).toEqual([
      { type: "text_delta", text: "done" },
    ]);
    // Two steps of 12 in and 3 out: the turn's totals, not the last step's.
    expect(parsed.filter((event) => event.type === "usage").at(-1)).toMatchObject({
      usage: { inputTokens: 24, outputTokens: 6, costUsd: 0 },
    });
  });

  it("reports OpenCode's error message", () => {
    const line = JSON.stringify({
      type: "error",
      error: { name: "UnknownError", data: { message: "Unexpected server error." } },
    });
    expect(parseOpencodeLine(line, { values: new Map() })).toEqual([
      {
        type: "error",
        error: { kind: "provider", message: "Unexpected server error.", retryable: false },
      },
    ]);
  });

  it("keeps text of later steps apart from the text before", () => {
    const state = { values: new Map<string, unknown>() };
    const text = (value: string): string =>
      JSON.stringify({ type: "text", part: { type: "text", text: value } });
    expect(parseOpencodeLine(text("Looking."), state)).toEqual([
      { type: "text_delta", text: "Looking." },
    ]);
    expect(parseOpencodeLine(text("Done."), state)).toEqual([
      { type: "text_delta", text: "\n\nDone." },
    ]);
  });
});

describe("OpenCode's server events", () => {
  const replay = (name: string, until: (event: unknown) => boolean): OpencodeServerState => {
    const state = new OpencodeServerState();
    for (const event of events(name)) {
      state.apply(event, new Date(1000));
      if (until(event)) {
        break;
      }
    }
    return state;
  };
  const typeIs =
    (type: string) =>
    (event: unknown): boolean =>
      (event as { type?: string }).type === type;

  it("shows a permission while it waits, working, and lets go once it was answered", () => {
    const waiting = replay("server-allow.jsonl", typeIs("permission.asked"));
    expect(waiting.attention).toMatchObject({
      kind: "permission",
      tool: "Bash",
      summary: "touch opencode-allowed.txt",
      answerable: true,
    });
    expect(waiting.activity?.state).toBe("working");

    const done = replay("server-allow.jsonl", () => false);
    expect(done.attention).toBeNull();
    expect(done.activity?.state).toBe("idle");
    expect(done.metrics()).toMatchObject({
      source: "OpenCode server",
      model: "standin-model",
      tokens: { input: 24, output: 6 },
      costUsd: 0,
    });
  });

  it("offers a question's choices, and forgets it once answered", () => {
    const waiting = replay("server-question.jsonl", typeIs("question.asked"));
    expect(waiting.attention).toMatchObject({
      kind: "question",
      summary: "Which colour should the button be?",
      answerable: true,
      choices: [
        { id: "0", label: "Blue", hint: "The calm one" },
        { id: "1", label: "Green", hint: "The fresh one" },
      ],
    });
    expect(replay("server-question.jsonl", () => false).attention).toBeNull();
  });

  it("reads the v2 form of a permission", () => {
    const state = new OpencodeServerState();
    state.apply(
      {
        type: "permission.v2.asked",
        properties: {
          id: "per_1",
          sessionID: "ses_1",
          action: "external_directory",
          resources: ["/etc/*"],
          metadata: {},
        },
      },
      new Date(0),
    );
    expect(state.attention).toMatchObject({ tool: "External directory", summary: "/etc/*" });
    state.apply({ type: "permission.v2.replied", properties: { requestID: "per_1" } }, new Date(0));
    expect(state.attention).toBeNull();
  });

  it("drops what a session asked once it stops, as when the person interrupts it", () => {
    const state = new OpencodeServerState();
    state.connected(new Date(0));
    state.apply(
      { type: "session.status", properties: { sessionID: "ses_1", status: { type: "busy" } } },
      new Date(1),
    );
    state.apply(
      {
        type: "permission.asked",
        properties: { id: "per_1", sessionID: "ses_1", permission: "bash", patterns: ["ls"] },
      },
      new Date(2),
    );
    expect(state.attention?.id).toBe("per_1");
    state.apply({ type: "session.idle", properties: { sessionID: "ses_1" } }, new Date(3));
    expect(state.attention).toBeNull();
    expect(state.activity).toEqual({ state: "idle", since: new Date(3) });
  });

  it("does not claim idle before the interface answers, and counts a retry as work", () => {
    const state = new OpencodeServerState();
    expect(state.activity).toBeNull();
    state.connected(new Date(5));
    expect(state.activity).toEqual({ state: "idle", since: new Date(5) });
    state.apply(
      {
        type: "session.status",
        properties: { sessionID: "ses_1", status: { type: "retry", attempt: 1, message: "", next: 0 } },
      },
      new Date(6),
    );
    expect(state.activity).toEqual({ state: "working", since: new Date(6) });
  });

  it("keeps what the stream reported after the server's lists were asked for", () => {
    const state = new OpencodeServerState();
    state.connected(new Date(0));
    const since = state.mark();
    // The lists are asked for; meanwhile the stream reports a new request
    // and the end of an old one that the lists still contain.
    state.apply(
      { type: "permission.asked", properties: { id: "per_new", sessionID: "ses_1", permission: "bash", patterns: ["ls"] } },
      new Date(1),
    );
    state.apply({ type: "permission.replied", properties: { requestID: "per_old" } }, new Date(2));
    state.apply(
      { type: "session.status", properties: { sessionID: "ses_1", status: { type: "busy" } } },
      new Date(3),
    );
    state.resync(
      {
        permissions: [{ id: "per_old", sessionID: "ses_0", permission: "bash", patterns: ["pwd"] }],
        questions: [],
        statuses: {},
      },
      new Date(4),
      since,
    );
    expect(state.attention?.id).toBe("per_new");
    expect(state.activity?.state).toBe("working");
  });

  it("takes back what was missed while the stream was down", () => {
    const state = new OpencodeServerState();
    state.connected(new Date(0));
    state.resync(
      {
        permissions: [{ id: "per_9", sessionID: "ses_2", permission: "edit", patterns: ["a.ts"], metadata: { filepath: "src/a.ts" } }],
        questions: [],
        statuses: { ses_2: { type: "busy" } },
      },
      new Date(10),
    );
    expect(state.attention).toMatchObject({ id: "per_9", tool: "Edit", summary: "src/a.ts" });
    expect(state.activity?.state).toBe("working");
  });
});

describe("OpenCode's models and stats", () => {
  it("reads names, groups, context and efforts from `opencode models --verbose`", () => {
    expect(parseOpencodeModels(fixture("models-verbose.txt"))).toEqual([
      {
        id: "opencode/big-pickle",
        displayName: "Big Pickle",
        group: "opencode",
        contextWindow: 200000,
        source: "provider",
      },
      {
        id: "standin/standin-model",
        displayName: "Stand-in model",
        group: "standin",
        source: "provider",
      },
    ]);
  });

  it("reads the plain list too, grouped by provider", () => {
    const models = parseOpencodeModels(fixture("models.txt"));
    expect(models[0]).toEqual({
      id: "opencode/big-pickle",
      displayName: "big-pickle",
      group: "opencode",
      source: "provider",
    });
    expect(new Set(models.map((model) => model.group))).toEqual(new Set(["opencode", "aihubmix"]));
  });

  it("keeps every model of the plain list when the verbose one was cut off", () => {
    const plain = parseOpencodeModels("opencode/big-pickle\nstandin/standin-model\n");
    // Cut inside the second record, as a pipe loses OpenCode's last output.
    const full = fixture("models-verbose.txt");
    const verbose = parseOpencodeModels(full.slice(0, full.length - 200));
    expect(mergeOpencodeModels(plain, verbose)).toEqual([
      expect.objectContaining({ id: "opencode/big-pickle", displayName: "Big Pickle" }),
      { id: "standin/standin-model", displayName: "standin-model", group: "standin", source: "provider" },
    ]);
  });

  it("reads the totals of the `opencode stats` table", () => {
    const week = parseStatsTable(fixture("stats.txt"));
    expect(week).toEqual({
      tokens: { input: 132, output: 33, cache: { read: 0, write: 0 } },
      cost: 0,
    });
    expect(statsLimits(null, week)).toEqual([
      { id: "week.tokens", label: "Tokens · 7 days", used: 165, unit: "tokens" },
      { id: "week.cost", label: "Cost · 7 days", used: 0, unit: "usd" },
    ]);
  });

  it("reads the table's rounded thousands and millions", () => {
    const table = [
      "│Total Cost                                       $12.34 │",
      "│Input                                              1.2M │",
      "│Output                                            45.6K │",
    ].join("\n");
    expect(parseStatsTable(table)).toMatchObject({
      tokens: { input: 1_200_000, output: 45_600 },
      cost: 12.34,
    });
    expect(parseStatsTable("opencode stats\n\nshow token usage")).toBeNull();
  });
});

describe("OpenCode's server connection", () => {
  let server: Server | null = null;
  afterEach(async () => {
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
    server = null;
  });

  /** A server shaped like OpenCode's: basic auth, an event stream, replies. */
  async function fakeServer(password: string): Promise<{ port: number; replies: unknown[] }> {
    const replies: unknown[] = [];
    const expected = `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`;
    server = createServer((request, response) => {
      if (request.headers.authorization !== expected) {
        response.writeHead(401).end();
        return;
      }
      if (request.url === "/event") {
        response.writeHead(200, { "content-type": "text/event-stream" });
        const send = (event: unknown): void => {
          response.write(`data: ${JSON.stringify(event)}\n\n`);
        };
        send({ type: "server.connected", properties: {} });
        send({ type: "session.status", properties: { sessionID: "ses_1", status: { type: "busy" } } });
        send({
          type: "permission.asked",
          properties: { id: "per_1", sessionID: "ses_1", permission: "bash", patterns: [], metadata: { command: "ls" } },
        });
        return;
      }
      if (request.url === "/permission" || request.url === "/question") {
        response.writeHead(200, { "content-type": "application/json" }).end("[]");
        return;
      }
      if (request.url === "/session/status") {
        response.writeHead(200, { "content-type": "application/json" }).end('{"ses_1":{"type":"busy"}}');
        return;
      }
      let body = "";
      request.on("data", (chunk: Buffer) => (body += chunk.toString()));
      request.on("end", () => {
        replies.push({ url: request.url, body: JSON.parse(body) as unknown });
        response.writeHead(200, { "content-type": "application/json" }).end("true");
      });
    });
    await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
    return { port: (server?.address() as AddressInfo).port, replies };
  }

  const until = async (check: () => boolean): Promise<void> => {
    const deadline = Date.now() + 5000;
    while (!check()) {
      if (Date.now() > deadline) {
        throw new Error("timed out");
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  };

  it("follows the stream with the run's password and answers through the server", async () => {
    const { port, replies } = await fakeServer("secret");
    const state = new OpencodeServerState();
    const link = new OpencodeServerLink(port, "secret", state, () => undefined);
    link.start();
    try {
      await until(() => state.attention !== null);
      expect(state.attention).toMatchObject({ tool: "Bash", summary: "ls" });
      expect(state.activity?.state).toBe("working");
      await expect(answerRequest(link, state, "per_1", { decision: "allow" })).resolves.toBe(true);
      expect(replies).toEqual([{ url: "/permission/per_1/reply", body: { reply: "once" } }]);
      expect(state.attention).toBeNull();
      // Nothing waits any more, so there is nothing to answer.
      await expect(answerRequest(link, state, "per_1", { decision: "deny" })).resolves.toBe(false);
    } finally {
      link.stop();
    }
  });

  it("tries again when the stream accepted the connection but never answered", async () => {
    // OpenCode 1.18 while its server starts: the first request is taken and
    // left without an answer for good.
    let calls = 0;
    const expected = `Basic ${Buffer.from("opencode:secret").toString("base64")}`;
    server = createServer((request, response) => {
      if (request.headers.authorization !== expected) {
        response.writeHead(401).end();
        return;
      }
      if (request.url === "/event") {
        calls += 1;
        if (calls === 1) {
          return;
        }
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.write(
          `data: ${JSON.stringify({ type: "session.status", properties: { sessionID: "ses_1", status: { type: "busy" } } })}\n\n`,
        );
        return;
      }
      response.writeHead(200, { "content-type": "application/json" }).end("[]");
    });
    await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
    const port = (server?.address() as AddressInfo).port;
    const state = new OpencodeServerState();
    const link = new OpencodeServerLink(port, "secret", state, () => undefined);
    link.start();
    try {
      const deadline = Date.now() + 10_000;
      while (state.activity?.state !== "working") {
        if (Date.now() > deadline) {
          throw new Error("never heard the server");
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      expect(calls).toBeGreaterThan(1);
    } finally {
      link.stop();
      server?.closeAllConnections();
    }
  }, 15_000);

  it("hears nothing with a wrong password", async () => {
    await fakeServer("secret");
    const port = (server?.address() as AddressInfo).port;
    const state = new OpencodeServerState();
    const link = new OpencodeServerLink(port, "wrong", state, () => undefined);
    link.start();
    await new Promise((resolve) => setTimeout(resolve, 300));
    link.stop();
    expect(state.attention).toBeNull();
    expect(state.activity).toBeNull();
  });
});

describe("OpenCode 2's command line", () => {
  it("reads the major version from what --version prints", () => {
    expect(parseMajor("2.0.15\n")).toBe(2);
    expect(parseMajor("opencode 1.18.32")).toBe(1);
    expect(parseMajor("0.0.0-dev-202609221946")).toBe(0);
    expect(parseMajor("unknown")).toBeNull();
  });

  it("moves a turn's variant into its model, as `--model provider/model#variant`", () => {
    expect(
      argsForOpencode2(
        ["run", "--format", "json", "--model", "openai/gpt-5.5", "--variant", "high", "--auto", "hi"],
        "turn",
      ),
    ).toEqual(["run", "--format", "json", "--model", "openai/gpt-5.5#high", "--auto", "hi"]);
    // Without a model there is nothing to attach a variant to.
    expect(argsForOpencode2(["run", "--variant", "high", "hi"], "turn")).toEqual(["run", "hi"]);
  });

  it("starts the terminal interface without the flags it no longer takes", () => {
    expect(
      argsForOpencode2(
        ["--port", "4123", "--hostname", "127.0.0.1", "--model", "a/b", "--variant", "high", "--auto"],
        "interactive",
      ),
    ).toEqual(["--auto"]);
  });
});
