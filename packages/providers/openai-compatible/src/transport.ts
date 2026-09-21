import { ProviderError } from "@ai-workbench/provider-base";
import type { Logger } from "@ai-workbench/shared";

export type FetchFn = typeof fetch;

export interface OpenAiCompatibleTransportOptions {
  readonly baseUrl: string;
  /** Resolved secret. Never logged; only sent as an Authorization header. */
  readonly apiKey?: string | null;
  readonly timeoutMs?: number;
  readonly fetchFn?: FetchFn;
  readonly logger?: Logger;
}

export interface ChatMessageInput {
  readonly role: "system" | "user" | "assistant";
  readonly content: string;
}

export interface StreamChatInput {
  readonly model: string;
  readonly messages: readonly ChatMessageInput[];
  readonly signal?: AbortSignal;
}

/** A streamed response: server-sent events plus the headers they came with. */
export interface StreamChatResult {
  readonly events: AsyncIterable<unknown>;
  readonly headers: Headers;
}

/**
 * Minimal HTTP transport for OpenAI-compatible endpoints (spec §11): `GET
 * /models` for discovery, `POST /chat/completions` with `stream: true` for
 * answers. Provider identity stays in the adapter; this only moves bytes.
 *
 * Secrets never reach the logs: requests are logged with the endpoint redacted
 * (origin plus path, no query, no user info, never headers), and failures carry
 * a truncated server message, never the request.
 */
export class OpenAiCompatibleTransport {
  readonly #baseUrl: string;
  readonly #apiKey: string | null;
  readonly #timeoutMs: number;
  readonly #fetchFn: FetchFn;
  readonly #logger: Logger | null;

  constructor(options: OpenAiCompatibleTransportOptions) {
    this.#baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.#apiKey = options.apiKey ?? null;
    this.#timeoutMs = options.timeoutMs ?? 120_000;
    this.#fetchFn = options.fetchFn ?? globalThis.fetch;
    this.#logger = options.logger ?? null;
  }

  /** Ids from `GET {baseUrl}/models`. Accepts `{data:[{id}]}` and bare `[{id}]`. */
  async listModels(signal?: AbortSignal): Promise<string[]> {
    const response = await this.#request("/models", { method: "GET" }, signal);
    const payload: unknown = await response.json().catch(() => null);
    const ids = extractModelIds(payload);
    this.#logger?.debug("OpenAI-compatible models listed", {
      endpoint: redactEndpoint(this.#baseUrl),
      count: ids.length,
    });
    return ids;
  }

  async streamChat(input: StreamChatInput): Promise<StreamChatResult> {
    const response = await this.#request(
      "/chat/completions",
      {
        method: "POST",
        body: JSON.stringify({ model: input.model, messages: input.messages, stream: true }),
      },
      input.signal,
    );
    if (!response.body) {
      throw new ProviderError("transport", "The server returned no response body", {
        detail: `POST ${redactEndpoint(this.#baseUrl)}/chat/completions`,
      });
    }
    this.#logger?.debug("OpenAI-compatible stream opened", {
      endpoint: redactEndpoint(this.#baseUrl),
      model: input.model,
    });
    return { events: parseServerSentEvents(response.body), headers: response.headers };
  }

  async #request(path: string, init: RequestInit, signal?: AbortSignal): Promise<Response> {
    const endpoint = `${this.#baseUrl}${path}`;
    let response: Response;
    try {
      response = await this.#fetchFn(endpoint, {
        ...init,
        headers: {
          "Content-Type": "application/json",
          Accept: "text/event-stream, application/json",
          ...(this.#apiKey ? { Authorization: `Bearer ${this.#apiKey}` } : {}),
        },
        signal: timeoutSignal(this.#timeoutMs, signal),
      });
    } catch (error) {
      throw toTransportError(error, endpoint);
    }
    if (!response.ok) {
      throw await toStatusError(response, endpoint);
    }
    return response;
  }
}

/** Turns a stored config plus its manifest into what the transport needs. */
export function readTransportSettings(settings: Record<string, unknown> | undefined): {
  baseUrl?: string;
  credentialReference?: string;
} {
  const raw = settings?.["openaiCompatible"];
  if (typeof raw !== "object" || raw === null) {
    return {};
  }
  const manifest = raw as Record<string, unknown>;
  const baseUrl = manifest["baseUrl"];
  const credentialReference = manifest["credentialReference"];
  return {
    ...(typeof baseUrl === "string" && baseUrl.length > 0 ? { baseUrl } : {}),
    ...(typeof credentialReference === "string" && credentialReference.length > 0
      ? { credentialReference }
      : {}),
  };
}

/** `origin + path`, never query, fragment or user info — safe to log. */
export function redactEndpoint(endpoint: string): string {
  try {
    const parsed = new URL(endpoint);
    return `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
  } catch {
    return "unparseable-endpoint";
  }
}

/** Yields each `data:` payload of a server-sent event stream as parsed JSON. */
export async function* parseServerSentEvents(body: ReadableStream<Uint8Array>): AsyncIterable<unknown> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let dataLines: string[] = [];

  /** Completes the pending event: its payloads, and whether `[DONE]` ended it. */
  const completeEvent = (): { events: unknown[]; finished: boolean } => {
    if (dataLines.length === 0) {
      return { events: [], finished: false };
    }
    const payload = dataLines.join("\n");
    dataLines = [];
    if (payload === "[DONE]") {
      return { events: [], finished: true };
    }
    const parsed: unknown = safeJsonParse(payload);
    return { events: parsed === undefined ? [] : [parsed], finished: false };
  };

  /** Feeds one raw line; a blank line completes the pending event. */
  const feedLine = (line: string): { events: unknown[]; finished: boolean } => {
    const text = line.endsWith("\r") ? line.slice(0, -1) : line;
    if (text === "") {
      return completeEvent();
    }
    if (!text.startsWith(":") && text.startsWith("data:")) {
      dataLines.push(text.slice(5).trimStart());
      if (dataLines.length === 1 && dataLines[0] === "[DONE]") {
        // `[DONE]` without a trailing blank line still ends the stream.
        return completeEvent();
      }
    }
    return { events: [], finished: false };
  };

  try {
    let finished = false;
    while (!finished) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const fed = feedLine(line);
        yield* fed.events;
        if (fed.finished) {
          finished = true;
          break;
        }
      }
    }
    if (!finished) {
      buffer += decoder.decode();
      if (buffer.trim().length > 0) {
        const text = buffer.endsWith("\r") ? buffer.slice(0, -1) : buffer;
        if (text.startsWith("data:")) {
          dataLines.push(text.slice(5).trimStart());
        }
      }
      const tail = completeEvent();
      yield* tail.events;
    }
  } finally {
    reader.releaseLock();
  }
}

function safeJsonParse(payload: string): unknown {
  try {
    return JSON.parse(payload) as unknown;
  } catch {
    return undefined;
  }
}

function extractModelIds(payload: unknown): string[] {
  const entries = Array.isArray(payload)
    ? payload
    : typeof payload === "object" && payload !== null && Array.isArray((payload as { data?: unknown }).data)
      ? (payload as { data: unknown[] }).data
      : [];
  const ids: string[] = [];
  for (const entry of entries) {
    if (typeof entry === "object" && entry !== null) {
      const id = (entry as { id?: unknown }).id;
      if (typeof id === "string" && id.length > 0 && !ids.includes(id)) {
        ids.push(id);
      }
    }
  }
  return ids;
}

function timeoutSignal(timeoutMs: number, signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  if (!signal) {
    return timeout;
  }
  if (signal.aborted) {
    return signal;
  }
  return AbortSignal.any([timeout, signal]);
}

function toTransportError(error: unknown, endpoint: string): ProviderError {
  if (error instanceof ProviderError) {
    return error;
  }
  if (error instanceof Error && error.name === "AbortError") {
    return new ProviderError("cancelled", "The request was cancelled");
  }
  if (error instanceof Error && error.name === "TimeoutError") {
    return new ProviderError("timeout", "The server did not answer in time", {
      retryable: true,
      detail: `GET ${redactEndpoint(endpoint)}`,
    });
  }
  return new ProviderError(
    "transport",
    "The server could not be reached",
    {
      retryable: true,
      ...(error instanceof Error && error.message
        ? { detail: `${redactEndpoint(endpoint)}: ${error.message}` }
        : { detail: redactEndpoint(endpoint) }),
    },
  );
}

async function toStatusError(response: Response, endpoint: string): Promise<ProviderError> {
  const body = await response.text().catch(() => "");
  const message = extractServerMessage(body) ?? `The server answered ${response.status}`;
  const detail = `${response.status} ${redactEndpoint(endpoint)}`;
  switch (response.status) {
    case 401:
    case 403:
      return new ProviderError("authentication", message, { detail });
    case 408:
    case 429:
      return new ProviderError(response.status === 429 ? "rateLimit" : "timeout", message, {
        retryable: true,
        detail,
      });
    case 404:
    case 400:
    case 422:
      return new ProviderError("provider", message, { detail });
    default:
      return new ProviderError("provider", message, {
        retryable: response.status >= 500,
        detail,
      });
  }
}

/** The OpenAI `{error:{message}}` shape, truncated — never a secret. */
function extractServerMessage(body: string): string | null {
  if (!body) {
    return null;
  }
  try {
    const parsed = JSON.parse(body) as unknown;
    if (typeof parsed === "object" && parsed !== null) {
      const error = (parsed as { error?: unknown }).error;
      if (typeof error === "string" && error.length > 0) {
        return error.slice(0, 500);
      }
      if (typeof error === "object" && error !== null) {
        const message = (error as { message?: unknown }).message;
        if (typeof message === "string" && message.length > 0) {
          return message.slice(0, 500);
        }
      }
    }
  } catch {
    // Not JSON: fall through to plain text.
  }
  const text = body.trim().split("\n")[0]?.trim() ?? "";
  return text.length > 0 ? text.slice(0, 500) : null;
}
