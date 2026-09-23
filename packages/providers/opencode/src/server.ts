import { randomBytes } from "node:crypto";
import { createServer } from "node:net";
import type {
  TerminalActivity,
  TerminalAttention,
  TerminalAttentionChoice,
  TerminalAttentionResponse,
  TerminalMetrics,
} from "@ai-workbench/shared";
import {
  field,
  numberField,
  oneLine,
  stringField,
  type CliInteractiveTelemetry,
} from "@ai-workbench/provider-cli";

/**
 * What an interactive OpenCode run waits on the person for, whether it works
 * or idles, and what its session has used — read from the server OpenCode's
 * own terminal interface starts.
 *
 * Measured against OpenCode 1.18.32 in its terminal interface, with a local
 * stand-in model, before this was built:
 *
 * - `opencode --port <port> --hostname 127.0.0.1` makes the interface listen
 *   there, about three seconds after it starts; `OPENCODE_SERVER_PASSWORD`
 *   protects it with basic auth (user `opencode`), and requests without the
 *   password, or with a wrong one, get 401.
 * - `GET /event` streams server-sent events `{ id, type, properties }`:
 *   `permission.asked` (`permission` such as "bash", `patterns`,
 *   `metadata.command`), `permission.replied`, `question.asked` (questions
 *   with labelled options), `question.replied` / `question.rejected`,
 *   `session.status` (`busy`, `retry`, `idle`), `session.idle`, and
 *   `session.updated` with the session's tokens, cost and model.
 * - `POST /permission/{id}/reply` with `once` runs the command and `reject`
 *   ends the turn; `POST /question/{id}/reply` with the chosen label goes on
 *   with the turn. The interface's own dialog closes either way, and stays
 *   usable until then.
 *
 * The same release already declares `permission.v2.*` and `question.v2.*`
 * events, where a permission names its `action` and `resources`; both forms
 * are read.
 */

export const OPENCODE_SERVER_SOURCE = "OpenCode server";

/** The user basic auth expects unless told otherwise; set explicitly anyway. */
const SERVER_USER = "opencode";
/** The interface takes a few seconds to listen; asked again this often. */
const RETRY_MS = 500;
const RETRY_MAX_MS = 5000;
const REQUEST_TIMEOUT_MS = 5000;

interface PendingRequest {
  readonly kind: "permission" | "question";
  readonly sessionId: string | undefined;
  readonly attention: TerminalAttention;
  /** The event count when it was added; later than a snapshot means newer. */
  readonly seq: number;
}

/** A tool name as a person reads it: "bash" → "Bash". */
function toolLabel(name: string): string {
  const spaced = name.replace(/[_-]+/g, " ").trim();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

/** A permission request, in either of the forms OpenCode sends. */
export function permissionAttention(request: unknown, since: Date): TerminalAttention | null {
  const id = stringField(request, "id");
  const name = stringField(request, "permission") ?? stringField(request, "action");
  if (!id || !name) {
    return null;
  }
  const patterns = stringList(field(request, "patterns") ?? field(request, "resources"));
  const summary =
    stringField(request, "metadata", "command") ??
    stringField(request, "metadata", "filepath") ??
    stringField(request, "metadata", "url") ??
    patterns.join(", ");
  return {
    id,
    kind: "permission",
    tool: oneLine(toolLabel(name), 120),
    summary: oneLine(summary),
    choices: [],
    answerable: true,
    since,
  };
}

/** A question request; only one single-choice question fits the island. */
export function questionAttention(request: unknown, since: Date): TerminalAttention | null {
  const id = stringField(request, "id");
  const questions = field(request, "questions");
  const list = Array.isArray(questions) ? questions : [];
  const first: unknown = list[0];
  if (!id || first === undefined) {
    return null;
  }
  const question = stringField(first, "question") ?? stringField(first, "header") ?? "OpenCode has a question";
  const options = field(first, "options");
  const choices = (Array.isArray(options) ? options : []).flatMap(
    (option: unknown, index): TerminalAttentionChoice[] => {
      const label = stringField(option, "label");
      const hint = stringField(option, "description");
      return label
        ? [{ id: String(index), label: oneLine(label, 200), ...(hint ? { hint: oneLine(hint, 200) } : {}) }]
        : [];
    },
  );
  const answerable =
    list.length === 1 && field(first, "multiple") !== true && choices.length > 0 && choices.length <= 9;
  return {
    id,
    kind: "question",
    tool: "Question",
    summary: oneLine(list.length > 1 ? `${question} (+${list.length - 1} more)` : question),
    choices: answerable ? choices : [],
    answerable,
    since,
  };
}

/** Metrics for one OpenCode session record: tokens, cost and model. */
export function sessionMetrics(session: unknown, source: string, at: Date): TerminalMetrics | null {
  const id = stringField(session, "id");
  if (!id) {
    return null;
  }
  const modelId = stringField(session, "model", "id") ?? stringField(session, "modelID");
  const input = numberField(session, "tokens", "input");
  const output = numberField(session, "tokens", "output");
  const reasoning = numberField(session, "tokens", "reasoning");
  const cacheRead = numberField(session, "tokens", "cache", "read");
  const cacheWrite = numberField(session, "tokens", "cache", "write");
  const cost = numberField(session, "cost");
  return {
    source,
    providerSessionId: id,
    ...(modelId === undefined ? {} : { model: modelId }),
    ...(input === undefined || output === undefined
      ? {}
      : {
          tokens: {
            input,
            output,
            ...(reasoning === undefined ? {} : { reasoning }),
            ...(cacheRead === undefined ? {} : { cacheRead }),
            ...(cacheWrite === undefined ? {} : { cacheWrite }),
          },
        }),
    // OpenCode prices the tokens itself from its model catalogue.
    ...(cost === undefined ? {} : { costUsd: cost, costEstimated: true }),
    limits: [],
    updatedAt: at,
  };
}

/**
 * What the server's events say, kept as state: the requests waiting on the
 * person in the order they came, each session's status, and the run's
 * sessions. Pure, so every rule here is tested without a server.
 */
export class OpencodeServerState {
  readonly #pending = new Map<string, PendingRequest>();
  readonly #busy = new Set<string>();
  readonly #sessions = new Map<string, { info: unknown; at: number }>();
  /** When each answered request was taken off, by event count. */
  readonly #removed = new Map<string, number>();
  /** When each session's status was last reported, by event count. */
  readonly #statusSeq = new Map<string, number>();
  #activity: TerminalActivity | null = null;
  #connected = false;
  #seq = 0;

  /** The oldest request still waiting, or null. */
  get attention(): TerminalAttention | null {
    return this.#pending.values().next().value?.attention ?? null;
  }

  get activity(): TerminalActivity | null {
    return this.#activity;
  }

  /** The waiting request with this id, for an answer. */
  request(id: string): PendingRequest | undefined {
    return this.#pending.get(id);
  }

  /** The run's main session as OpenCode last reported it. */
  metrics(): TerminalMetrics | null {
    let latest: { info: unknown; at: number } | undefined;
    for (const entry of this.#sessions.values()) {
      if (!latest || entry.at >= latest.at) {
        latest = entry;
      }
    }
    return latest ? sessionMetrics(latest.info, OPENCODE_SERVER_SOURCE, new Date(latest.at)) : null;
  }

  /** The event count now; a snapshot asked for after this knows what came before. */
  mark(): number {
    return this.#seq;
  }

  /** The stream is up: the interface answers, so it idles unless told otherwise. */
  connected(now: Date): void {
    this.#connected = true;
    this.#settle(now);
  }

  /**
   * Takes in what may have been missed while the stream was down: the
   * requests still waiting and the sessions still working, as the server
   * listed them when asked at `since` (see `mark`). Whatever the stream
   * reported after that is newer than the lists and stays.
   */
  resync(
    snapshot: {
      readonly permissions: readonly unknown[];
      readonly questions: readonly unknown[];
      readonly statuses: unknown;
    },
    now: Date,
    since = this.#seq,
  ): void {
    const previous = new Map(this.#pending);
    const newer = [...previous.values()].filter((request) => request.seq > since);
    this.#pending.clear();
    const fromSnapshot = (kind: "permission" | "question", request: unknown): void => {
      const id = stringField(request, "id");
      if (id && (this.#removed.get(id) ?? -1) > since) {
        return;
      }
      this.#add(kind, request, previous, now, since);
    };
    for (const request of snapshot.permissions) {
      fromSnapshot("permission", request);
    }
    for (const request of snapshot.questions) {
      fromSnapshot("question", request);
    }
    for (const request of newer) {
      this.#pending.set(request.attention.id, request);
    }

    const listed = new Set<string>();
    if (typeof snapshot.statuses === "object" && snapshot.statuses !== null) {
      for (const [sessionId, status] of Object.entries(snapshot.statuses)) {
        const type = stringField(status, "type");
        if (type === "busy" || type === "retry") {
          listed.add(sessionId);
        }
      }
    }
    const reportedLater = (sessionId: string): boolean =>
      (this.#statusSeq.get(sessionId) ?? -1) > since;
    for (const sessionId of [...this.#busy]) {
      if (!listed.has(sessionId) && !reportedLater(sessionId)) {
        this.#busy.delete(sessionId);
      }
    }
    for (const sessionId of listed) {
      if (!reportedLater(sessionId)) {
        this.#busy.add(sessionId);
      }
    }
    this.#settle(now);
  }

  /** Applies one event of the stream. */
  apply(event: unknown, now: Date): void {
    this.#seq += 1;
    const type = stringField(event, "type") ?? "";
    const properties = field(event, "properties");
    switch (type) {
      case "server.connected":
        this.connected(now);
        return;
      case "permission.asked":
      case "permission.v2.asked":
        this.#add("permission", properties, this.#pending, now);
        return;
      case "question.asked":
      case "question.v2.asked":
        this.#add("question", properties, this.#pending, now);
        return;
      case "permission.replied":
      case "permission.v2.replied":
      case "question.replied":
      case "question.v2.replied":
      case "question.rejected":
      case "question.v2.rejected": {
        const id = stringField(properties, "requestID") ?? stringField(properties, "id");
        if (id) {
          this.resolve(id);
        }
        return;
      }
      case "session.status": {
        const sessionId = stringField(properties, "sessionID");
        const status = stringField(properties, "status", "type");
        if (!sessionId || !status) {
          return;
        }
        this.#statusSeq.set(sessionId, this.#seq);
        if (status === "busy" || status === "retry") {
          this.#busy.add(sessionId);
        } else {
          this.#idle(sessionId);
        }
        this.#settle(now);
        return;
      }
      case "session.idle": {
        const sessionId = stringField(properties, "sessionID");
        if (sessionId) {
          this.#statusSeq.set(sessionId, this.#seq);
          this.#idle(sessionId);
          this.#settle(now);
        }
        return;
      }
      case "session.created":
      case "session.updated": {
        const info = field(properties, "info");
        const id = stringField(info, "id");
        // Sub-agents run in child sessions; the run is its main session.
        if (id && field(info, "parentID") === undefined) {
          this.#sessions.set(id, {
            info,
            at: numberField(info, "time", "updated") ?? now.getTime(),
          });
        }
        return;
      }
      case "session.deleted": {
        const id = stringField(properties, "info", "id") ?? stringField(properties, "sessionID");
        if (id) {
          this.#sessions.delete(id);
          this.#idle(id);
          this.#settle(now);
        }
        return;
      }
      default:
        return;
    }
  }

  /** Forgets a request once it was answered, here or in the terminal. */
  resolve(id: string): void {
    this.#pending.delete(id);
    this.#removed.set(id, this.#seq);
  }

  /** A session that stopped no longer waits on anyone, whatever it asked. */
  #idle(sessionId: string): void {
    this.#busy.delete(sessionId);
    for (const [id, request] of this.#pending) {
      if (request.sessionId === sessionId) {
        this.resolve(id);
      }
    }
  }

  #add(
    kind: "permission" | "question",
    request: unknown,
    previous: ReadonlyMap<string, PendingRequest>,
    now: Date,
    seq = this.#seq,
  ): void {
    const id = stringField(request, "id");
    // A request seen before keeps the time it started waiting.
    const since = (id ? previous.get(id)?.attention.since : undefined) ?? now;
    const attention =
      kind === "permission" ? permissionAttention(request, since) : questionAttention(request, since);
    if (attention) {
      this.#pending.set(attention.id, {
        kind,
        sessionId: stringField(request, "sessionID"),
        attention,
        seq,
      });
    }
  }

  #settle(now: Date): void {
    if (!this.#connected) {
      return;
    }
    const state = this.#busy.size > 0 ? "working" : "idle";
    if (this.#activity?.state !== state) {
      this.#activity = { state, since: now };
    }
  }
}

/** A port on the loopback interface that nothing listens on right now. */
export function freePort(): Promise<number | null> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(null));
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : null;
      server.close(() => resolve(port));
    });
  });
}

/** Reads server-sent events from a response body, one JSON payload each. */
async function readEvents(
  body: ReadableStream<Uint8Array>,
  onEvent: (event: unknown) => void,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) {
      return;
    }
    buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");
    let end = buffer.indexOf("\n\n");
    while (end >= 0) {
      const block = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      const data = block
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .join("\n");
      if (data) {
        try {
          onEvent(JSON.parse(data));
        } catch {
          // Not JSON: nothing this reader knows.
        }
      }
      end = buffer.indexOf("\n\n");
    }
  }
}

/**
 * The connection to one run's server: follows its event stream for as long
 * as it is started, and asks again while the interface is still starting or
 * after the stream broke off.
 */
export class OpencodeServerLink {
  readonly #base: string;
  readonly #auth: string;
  readonly #state: OpencodeServerState;
  readonly #onChange: () => void;
  #controller: AbortController | null = null;

  constructor(port: number, password: string, state: OpencodeServerState, onChange: () => void) {
    this.#base = `http://127.0.0.1:${port}`;
    this.#auth = `Basic ${Buffer.from(`${SERVER_USER}:${password}`).toString("base64")}`;
    this.#state = state;
    this.#onChange = onChange;
  }

  get running(): boolean {
    return this.#controller !== null;
  }

  start(): void {
    if (this.#controller) {
      return;
    }
    const controller = new AbortController();
    this.#controller = controller;
    void this.#follow(controller.signal);
  }

  stop(): void {
    this.#controller?.abort();
    this.#controller = null;
  }

  /** One request to the server; null when it did not answer with JSON. */
  async request(method: "GET" | "POST", path: string, body?: unknown): Promise<unknown> {
    try {
      const response = await fetch(`${this.#base}${path}`, {
        method,
        headers: {
          authorization: this.#auth,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (!response.ok) {
        await response.body?.cancel();
        return null;
      }
      return (await response.json()) as unknown;
    } catch {
      return null;
    }
  }

  async #follow(signal: AbortSignal): Promise<void> {
    let delay = RETRY_MS;
    while (!signal.aborted) {
      try {
        const response = await fetch(`${this.#base}/event`, {
          headers: { authorization: this.#auth, accept: "text/event-stream" },
          signal,
        });
        if (response.ok && response.body) {
          delay = RETRY_MS;
          this.#state.connected(new Date());
          void this.#resync();
          await readEvents(response.body, (event) => {
            this.#state.apply(event, new Date());
            this.#onChange();
          });
        } else {
          await response.body?.cancel();
        }
      } catch {
        // Not listening yet, or the stream broke off.
      }
      if (signal.aborted) {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, delay).unref?.());
      delay = Math.min(delay * 2, RETRY_MAX_MS);
    }
  }

  async #resync(): Promise<void> {
    const since = this.#state.mark();
    const [permissions, questions, statuses] = await Promise.all([
      this.request("GET", "/permission"),
      this.request("GET", "/question"),
      this.request("GET", "/session/status"),
    ]);
    this.#state.resync(
      {
        permissions: Array.isArray(permissions) ? permissions : [],
        questions: Array.isArray(questions) ? questions : [],
        statuses,
      },
      new Date(),
      since,
    );
    this.#onChange();
  }
}

/** Answers a waiting request through the server; false when it did not take it. */
export async function answerRequest(
  link: OpencodeServerLink,
  state: OpencodeServerState,
  attentionId: string,
  response: TerminalAttentionResponse,
): Promise<boolean> {
  const request = state.request(attentionId);
  if (!request || !request.attention.answerable) {
    return false;
  }
  const id = encodeURIComponent(attentionId);
  let answered: unknown;
  if (request.kind === "permission" && "decision" in response) {
    const reply = response.decision === "allow" ? "once" : "reject";
    answered = await link.request("POST", `/permission/${id}/reply`, { reply });
    if (answered !== true && request.sessionId) {
      // The route releases before 1.x used; kept by the server as deprecated.
      answered = await link.request(
        "POST",
        `/session/${encodeURIComponent(request.sessionId)}/permissions/${id}`,
        { response: reply },
      );
    }
  } else if (request.kind === "question" && "choice" in response) {
    const choice = request.attention.choices.find((entry) => entry.id === response.choice);
    if (!choice) {
      return false;
    }
    answered = await link.request("POST", `/question/${id}/reply`, { answers: [[choice.label]] });
  } else {
    return false;
  }
  if (answered !== true) {
    return false;
  }
  state.resolve(attentionId);
  return true;
}

/**
 * The server part of one run's telemetry: the arguments that make the
 * interface listen, a password only this run knows, and watchers that share
 * one connection.
 */
export async function opencodeServerTelemetry(): Promise<Required<
  Pick<CliInteractiveTelemetry, "args" | "env" | "watch" | "watchAttention" | "watchActivity" | "respond">
> | null> {
  const port = await freePort();
  if (port === null) {
    return null;
  }
  const password = randomBytes(24).toString("base64url");
  const state = new OpencodeServerState();
  const listeners = {
    metrics: null as ((metrics: TerminalMetrics) => void) | null,
    attention: null as ((attention: TerminalAttention | null) => void) | null,
    activity: null as ((activity: TerminalActivity | null) => void) | null,
  };
  const last = { metrics: "", attention: "", activity: "" };
  const signature = (value: unknown): string => (value ? JSON.stringify(value) : "null");
  const publish = (): void => {
    const metrics = state.metrics();
    if (metrics && signature(metrics) !== last.metrics) {
      last.metrics = signature(metrics);
      listeners.metrics?.(metrics);
    }
    const attention = state.attention;
    if (signature(attention) !== last.attention) {
      last.attention = signature(attention);
      listeners.attention?.(attention);
    }
    const activity = state.activity;
    if (signature(activity) !== last.activity) {
      last.activity = signature(activity);
      listeners.activity?.(activity);
    }
  };
  const link = new OpencodeServerLink(port, password, state, publish);
  const follow = (key: keyof typeof listeners, listener: never): (() => void) => {
    listeners[key] = listener;
    last[key] = "";
    link.start();
    publish();
    return () => {
      listeners[key] = null;
      if (!listeners.metrics && !listeners.attention && !listeners.activity) {
        link.stop();
      }
    };
  };
  return {
    args: ["--port", String(port), "--hostname", "127.0.0.1"],
    env: { OPENCODE_SERVER_PASSWORD: password, OPENCODE_SERVER_USERNAME: SERVER_USER },
    watch: (onMetrics) => follow("metrics", onMetrics as never),
    watchAttention: (onAttention) => follow("attention", onAttention as never),
    watchActivity: (onActivity) => follow("activity", onActivity as never),
    respond: async (attentionId, response) => {
      const answered = await answerRequest(link, state, attentionId, response);
      publish();
      return answered;
    },
  };
}
