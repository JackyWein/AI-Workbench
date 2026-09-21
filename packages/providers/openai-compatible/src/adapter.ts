import {
  ProviderError,
  normalizeError,
  type AIProviderAdapter,
  type AgentMessage,
  type ProviderContext,
  type ProviderSessionConfig,
  type ProviderSessionHandle,
  type ProviderSessionInfo,
} from "@ai-workbench/provider-base";
import type {
  AuthStatus,
  InstallationStatus,
  Logger,
  ModelInfo,
  ProviderCapabilities,
  ProviderEvent,
  ProviderMetadata,
  ProviderUsageSnapshot,
  UsageLimit,
} from "@ai-workbench/shared";
import { modelInfoSchema } from "@ai-workbench/shared";
import {
  openAiCompatibleProfileSchema,
  type OpenAiCompatibleProfile,
  type OpenAiCompatibleProfileInput,
} from "./profile.js";
import {
  OpenAiCompatibleTransport,
  readTransportSettings,
  redactEndpoint,
  type ChatMessageInput,
  type FetchFn,
} from "./transport.js";

export interface OpenAiCompatibleAdapterOptions {
  readonly fetchFn?: FetchFn;
}

interface SessionState {
  systemInstructions: string | undefined;
  history: ChatMessageInput[];
}

/** How much conversation is kept per session; the endpoint itself is stateless. */
const MAX_HISTORY_MESSAGES = 100;
const INSTALLATION_TIMEOUT_MS = 10_000;
const AUTH_TIMEOUT_MS = 15_000;

/**
 * Any OpenAI-compatible server as a provider (spec §11, §16): Ollama, llama.cpp,
 * vLLM, OpenRouter, a company gateway — driven by a validated profile, so adding
 * one is data, not a code change. Chat completions are stateless per request, so
 * the adapter carries the conversation and sends it with every turn; after an
 * app restart the history starts over while the session itself continues, which
 * the session event reports honestly through `resumable`.
 *
 * Secrets stay out of the logs: the API key travels only in the Authorization
 * header, endpoints are logged redacted, and failures carry a truncated server
 * message, never the request.
 */
export class OpenAiCompatibleAdapter implements AIProviderAdapter {
  readonly metadata: ProviderMetadata;
  readonly #profile: OpenAiCompatibleProfile;
  readonly #fetchFn: FetchFn | undefined;
  readonly #sessions = new Map<string, SessionState>();
  readonly #aborts = new Map<string, AbortController>();
  readonly #logger: Logger = forwardingLogger(() => this.#context?.logger ?? null);

  /** Models reported by the server itself, with when they were read. */
  #providerModels: ModelInfo[] = [];
  #modelsUpdatedAt: Date | null = null;
  #usage: ProviderUsageSnapshot | null = null;

  #context: ProviderContext | null = null;
  #baseUrl: string | null = null;
  #credentialReference: string | null = null;
  #defaultModel: string | undefined = undefined;
  #userModels: ModelInfo[] = [];

  constructor(profile: OpenAiCompatibleProfile, options: OpenAiCompatibleAdapterOptions = {}) {
    this.#profile = profile;
    this.#fetchFn = options.fetchFn;
    const needsKey = profile.credentialReference !== undefined;
    this.metadata = {
      id: profile.id,
      displayName: profile.displayName,
      ...(profile.description === undefined ? {} : { description: profile.description }),
      adapterVersion: "1.0.0",
      authMethods: needsKey ? ["apiKey"] : ["none"],
      transportTypes: ["openai-compatible", "http"],
    };
  }

  get profile(): OpenAiCompatibleProfile {
    return this.#profile;
  }

  async initialize(context: ProviderContext): Promise<void> {
    this.#context = context;
    const config = context.config;
    const manifest = readTransportSettings(config.settings);
    const baseUrl = config.baseUrl ?? manifest.baseUrl ?? this.#profile.baseUrl;
    this.#baseUrl = baseUrl.replace(/\/+$/, "") || null;
    this.#credentialReference =
      config.credentialReference ??
      manifest.credentialReference ??
      this.#profile.credentialReference ??
      null;
    this.#defaultModel =
      config.defaultModel ?? this.#profile.defaultModel ?? firstId(this.#profile.models);
    this.#userModels = validModels(config.settings?.["models"]);
    this.#sessions.clear();
    this.#usage = null;
  }

  async dispose(): Promise<void> {
    for (const abort of this.#aborts.values()) {
      abort.abort();
    }
    this.#aborts.clear();
    this.#sessions.clear();
    this.#context = null;
  }

  async detectInstallation(): Promise<InstallationStatus> {
    const baseUrl = this.#baseUrl;
    if (!baseUrl) {
      return {
        state: "notInstalled",
        detail: "No base URL is configured for this provider",
      };
    }
    try {
      const ids = await this.#transport(null, INSTALLATION_TIMEOUT_MS).listModels();
      return {
        state: "installed",
        detail: `OpenAI-compatible server at ${hostOf(baseUrl)} serving ${ids.length} model${ids.length === 1 ? "" : "s"}`,
      };
    } catch (error) {
      // An answer — even a refusal — proves the server is there; only silence
      // means it is missing.
      if (error instanceof ProviderError && error.kind !== "transport" && error.kind !== "timeout") {
        return {
          state: "installed",
          detail: `Server at ${hostOf(baseUrl)} answered, but the request was refused (${error.kind})`,
        };
      }
      return {
        state: "notInstalled",
        detail: `No OpenAI-compatible server answered at ${hostOf(baseUrl)}`,
      };
    }
  }

  async getAuthenticationStatus(): Promise<AuthStatus> {
    const reference = this.#credentialReference;
    if (!reference) {
      return {
        state: "notApplicable",
        method: "none",
        detail: "No API key is configured; local servers usually need none",
      };
    }
    const apiKey = await this.#resolveCredential(reference);
    if (!apiKey) {
      return {
        state: "authenticationRequired",
        method: "apiKey",
        detail: "The stored credential could not be resolved; check its reference",
      };
    }
    if (!this.#baseUrl) {
      return {
        state: "authenticationRequired",
        method: "apiKey",
        detail: "No base URL is configured for this provider",
      };
    }
    try {
      await this.#transport(apiKey, AUTH_TIMEOUT_MS).listModels();
      return { state: "authenticated", method: "apiKey" };
    } catch (error) {
      if (error instanceof ProviderError && (error.kind === "authentication" || error.kind === "rateLimit")) {
        return {
          state: "authenticationRequired",
          method: "apiKey",
          detail: error.message,
        };
      }
      return {
        state: "unknown",
        method: "apiKey",
        detail: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async getCapabilities(): Promise<ProviderCapabilities> {
    const supported: ProviderCapabilities["supported"] = [
      "chat",
      "streaming",
      "sessionResume",
      "modelSelection",
      "usage",
    ];
    if (this.#credentialReference) {
      supported.push("apiKey");
    }
    return { supported };
  }

  async listModels(): Promise<ModelInfo[]> {
    return mergeModels(this.#userModels, this.#providerModels, this.#profile.models);
  }

  async refreshModels(): Promise<ModelInfo[]> {
    if (this.#baseUrl) {
      try {
        const apiKey = this.#credentialReference
          ? await this.#resolveCredential(this.#credentialReference)
          : null;
        const ids = await this.#transport(apiKey, AUTH_TIMEOUT_MS).listModels();
        this.#providerModels = ids.map((id) => ({ id, displayName: id, source: "provider" as const }));
        this.#modelsUpdatedAt = new Date();
      } catch (error) {
        this.#logger.warn("Model refresh failed; keeping the last known list", {
          providerId: this.metadata.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return this.listModels();
  }

  getModelsUpdatedAt(): Date | null {
    return this.#modelsUpdatedAt;
  }

  async createSession(config: ProviderSessionConfig): Promise<ProviderSessionInfo> {
    const providerSessionId = `oac:${config.sessionId}`;
    this.#sessions.set(providerSessionId, {
      systemInstructions: config.systemInstructions,
      history: [],
    });
    const modelId = config.modelId ?? this.#defaultModel;
    return {
      providerSessionId,
      resumable: true,
      ...(modelId ? { modelId } : {}),
    };
  }

  async resumeSession(
    providerSessionId: string,
    config: ProviderSessionConfig,
  ): Promise<ProviderSessionInfo> {
    const existing = this.#sessions.get(providerSessionId);
    this.#sessions.set(providerSessionId, {
      systemInstructions: config.systemInstructions,
      // A restarted app resumes with an empty history: the endpoint keeps no
      // server-side session, so earlier turns cannot be rebuilt from its side.
      history: existing?.history ?? [],
    });
    const modelId = config.modelId ?? this.#defaultModel;
    return {
      providerSessionId,
      resumable: true,
      ...(modelId ? { modelId } : {}),
    };
  }

  async *sendMessage(
    session: ProviderSessionHandle,
    message: AgentMessage,
  ): AsyncIterable<ProviderEvent> {
    const baseUrl = this.#baseUrl;
    if (!baseUrl) {
      yield {
        type: "error",
        error: {
          kind: "transport",
          message: `No base URL is configured for "${this.metadata.id}"`,
          retryable: false,
        },
      };
      yield { type: "completed", reason: "failed" };
      return;
    }

    const modelId = session.modelId ?? this.#defaultModel ?? firstId(await this.listModels());
    if (!modelId) {
      yield {
        type: "error",
        error: {
          kind: "provider",
          message: `No model is configured for "${this.metadata.id}"; add its model ids on the Providers screen`,
          retryable: false,
        },
      };
      yield { type: "completed", reason: "failed" };
      return;
    }

    const apiKey = this.#credentialReference
      ? await this.#resolveCredential(this.#credentialReference)
      : null;
    const state = this.#sessions.get(session.providerSessionId) ?? {
      systemInstructions: undefined,
      history: [],
    };
    this.#sessions.set(session.providerSessionId, state);

    const messages: ChatMessageInput[] = [
      ...(state.systemInstructions
        ? [{ role: "system" as const, content: state.systemInstructions }]
        : []),
      ...state.history,
      { role: "user" as const, content: message.text },
    ];

    const abort = new AbortController();
    this.#aborts.set(session.sessionId, abort);

    yield { type: "session", providerSessionId: session.providerSessionId, resumable: true };
    yield { type: "status", status: "streaming" };

    let stream: Awaited<ReturnType<OpenAiCompatibleTransport["streamChat"]>>;
    try {
      stream = await this.#transport(apiKey, this.#profile.timeoutMs).streamChat({
        model: modelId,
        messages,
        signal: abort.signal,
      });
    } catch (error) {
      yield { type: "error", error: normalizeError(error) };
      yield { type: "completed", reason: failedOrCancelled(abort, error) };
      return;
    }

    let assistantText = "";
    let sawToolCalls = false;
    let inputTokens: number | undefined;
    let outputTokens: number | undefined;
    try {
      for await (const chunk of stream.events) {
        if (abort.signal.aborted) {
          break;
        }
        const parsed = parseChunk(chunk);
        if (parsed.text) {
          assistantText += parsed.text;
          yield { type: "text_delta", text: parsed.text };
        }
        if (parsed.toolCalls) {
          sawToolCalls = true;
        }
        if (parsed.inputTokens !== undefined) {
          inputTokens = parsed.inputTokens;
        }
        if (parsed.outputTokens !== undefined) {
          outputTokens = parsed.outputTokens;
        }
        if (parsed.refused === "content_filter") {
          yield {
            type: "error",
            error: {
              kind: "provider",
              message: "The server refused to answer (content filter)",
              retryable: false,
            },
          };
          yield { type: "completed", reason: "failed" };
          return;
        }
      }
    } catch (error) {
      if (abort.signal.aborted || (error instanceof Error && error.name === "AbortError")) {
        yield { type: "completed", reason: "cancelled" };
        return;
      }
      yield { type: "error", error: normalizeError(error) };
      yield { type: "completed", reason: "failed" };
      return;
    } finally {
      this.#aborts.delete(session.sessionId);
    }

    if (abort.signal.aborted) {
      yield { type: "completed", reason: "cancelled" };
      return;
    }

    // The turn only joins the history once it completed: a failed turn is
    // retried with the same context instead of baking the failure in.
    state.history.push({ role: "user", content: message.text });
    if (assistantText.length > 0) {
      state.history.push({ role: "assistant", content: assistantText });
    }
    while (state.history.length > MAX_HISTORY_MESSAGES) {
      state.history.shift();
    }

    if (sawToolCalls) {
      yield {
        type: "warning",
        message: "The model tried to call tools, which this endpoint setup does not support",
      };
    }
    if (inputTokens !== undefined || outputTokens !== undefined || stream.headers) {
      const limits = limitsFromHeaders(stream.headers);
      this.#usage = {
        providerId: this.metadata.id,
        ...(modelId ? { modelId } : {}),
        state: limits.length > 0 ? "available" : "partial",
        limits,
        updatedAt: new Date(),
        source: "api",
        ...(limits.length > 0
          ? {}
          : { note: "The server reported token counts but no rate limits" }),
      };
      yield {
        type: "usage",
        usage: {
          limits,
          ...(inputTokens === undefined ? {} : { inputTokens }),
          ...(outputTokens === undefined ? {} : { outputTokens }),
        },
      };
    }
    yield { type: "completed", reason: "finished" };
  }

  async cancel(session: ProviderSessionHandle): Promise<void> {
    this.#aborts.get(session.sessionId)?.abort();
  }

  async destroySession(session: ProviderSessionHandle): Promise<void> {
    this.#aborts.get(session.sessionId)?.abort();
    this.#aborts.delete(session.sessionId);
    this.#sessions.delete(session.providerSessionId);
  }

  async getUsage(): Promise<ProviderUsageSnapshot> {
    return (
      this.#usage ?? {
        providerId: this.metadata.id,
        state: "unavailable",
        limits: [],
        updatedAt: new Date(),
        source: "api",
        note: "No usage has been reported yet",
      }
    );
  }

  #transport(apiKey: string | null, timeoutMs: number): OpenAiCompatibleTransport {
    return new OpenAiCompatibleTransport({
      baseUrl: this.#baseUrl ?? "",
      ...(apiKey ? { apiKey } : {}),
      timeoutMs,
      ...(this.#fetchFn ? { fetchFn: this.#fetchFn } : {}),
      logger: this.#logger,
    });
  }

  async #resolveCredential(reference: string): Promise<string | null> {
    try {
      return (await this.#context?.resolveCredential?.(reference)) ?? null;
    } catch (error) {
      this.#logger.warn("Credential resolution failed", {
        providerId: this.metadata.id,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }
}

/** Creates the adapter for a profile input — the only integration point. */
export function createOpenAiCompatibleAdapter(
  profile: OpenAiCompatibleProfileInput,
  options: OpenAiCompatibleAdapterOptions = {},
): OpenAiCompatibleAdapter {
  return new OpenAiCompatibleAdapter(openAiCompatibleProfileSchema.parse(profile), options);
}

interface ParsedChunk {
  text: string;
  toolCalls: boolean;
  inputTokens?: number;
  outputTokens?: number;
  refused?: string;
}

/** Reads one chat-completion chunk; unknown shapes contribute nothing. */
function parseChunk(chunk: unknown): ParsedChunk {
  const result: ParsedChunk = { text: "", toolCalls: false };
  if (typeof chunk !== "object" || chunk === null) {
    return result;
  }
  const record = chunk as Record<string, unknown>;
  const choices = record["choices"];
  if (Array.isArray(choices)) {
    const first = choices[0] as Record<string, unknown> | undefined;
    const delta = first?.["delta"];
    if (typeof delta === "object" && delta !== null) {
      const content = (delta as Record<string, unknown>)["content"];
      if (typeof content === "string") {
        result.text = content;
      }
      const toolCalls = (delta as Record<string, unknown>)["tool_calls"];
      if (Array.isArray(toolCalls) && toolCalls.length > 0) {
        result.toolCalls = true;
      }
    }
    const finishReason = first?.["finish_reason"];
    if (typeof finishReason === "string" && finishReason.length > 0) {
      result.refused = finishReason;
    }
  }
  const usage = record["usage"];
  if (typeof usage === "object" && usage !== null) {
    const input = (usage as Record<string, unknown>)["prompt_tokens"];
    const output = (usage as Record<string, unknown>)["completion_tokens"];
    if (typeof input === "number" && Number.isFinite(input) && input >= 0) {
      result.inputTokens = Math.floor(input);
    }
    if (typeof output === "number" && Number.isFinite(output) && output >= 0) {
      result.outputTokens = Math.floor(output);
    }
  }
  return result;
}

/**
 * Rate-limit headers (OpenAI, OpenRouter and most gateways send these) become
 * usage limits (spec §55). Unknown or unparseable headers are skipped rather
 * than guessed.
 */
export function limitsFromHeaders(headers: Headers): UsageLimit[] {
  const limits: UsageLimit[] = [];
  const requests = rateLimit(headers, "requests", "Requests");
  if (requests) {
    limits.push(requests);
  }
  const tokens = rateLimit(headers, "tokens", "Tokens");
  if (tokens) {
    limits.push(tokens);
  }
  return limits;
}

function rateLimit(headers: Headers, kind: "requests" | "tokens", label: string): UsageLimit | null {
  const remaining = toNonNegativeInt(headers.get(`x-ratelimit-remaining-${kind}`));
  const total = toNonNegativeInt(headers.get(`x-ratelimit-limit-${kind}`));
  if (remaining === null && total === null) {
    return null;
  }
  const resetRaw = headers.get(`x-ratelimit-reset-${kind}`);
  const resetsAt = resetRaw ? parseReset(resetRaw) : undefined;
  return {
    id: kind,
    label,
    ...(remaining === null ? {} : { remaining }),
    ...(total === null ? {} : { total }),
    unit: "requests",
    ...(resetsAt === undefined
      ? resetRaw
        ? { resetsText: resetRaw }
        : {}
      : { resetsAt }),
  };
}

function toNonNegativeInt(value: string | null): number | null {
  if (value === null || !/^\d+$/.test(value.trim())) {
    return null;
  }
  return Number(value.trim());
}

function parseReset(value: string): Date | undefined {
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) {
    const numeric = Number(trimmed);
    if (numeric > 1e12) {
      return new Date(numeric);
    }
    if (numeric > 1e9) {
      return new Date(numeric * 1000);
    }
    return new Date(Date.now() + numeric * 1000);
  }
  const parsed = Date.parse(trimmed);
  return Number.isNaN(parsed) ? undefined : new Date(parsed);
}

/** User-maintained entries from settings, validated like the CLI adapter does. */
function validModels(value: unknown): ModelInfo[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const valid: ModelInfo[] = [];
  for (const entry of value) {
    const parsed = modelInfoSchema.safeParse(entry);
    if (parsed.success) {
      valid.push(parsed.data);
    }
  }
  return valid;
}

/**
 * User entries win on id conflicts, then what the server reported, then the
 * profile's list. Exactly one entry is the default.
 */
export function mergeModels(
  user: readonly ModelInfo[],
  provider: readonly ModelInfo[],
  profile: readonly ModelInfo[],
): ModelInfo[] {
  const merged: ModelInfo[] = [];
  const seen = new Set<string>();
  for (const model of [...user, ...provider, ...profile]) {
    if (!seen.has(model.id)) {
      seen.add(model.id);
      merged.push({ ...model });
    }
  }
  // Exactly one entry is the default: the first one marked, or the first one.
  let defaultIndex = merged.findIndex((model) => model.isDefault);
  if (defaultIndex < 0) {
    defaultIndex = 0;
  }
  return merged.map((model, index) =>
    index === defaultIndex ? { ...model, isDefault: true } : { ...model, isDefault: false },
  );
}

function firstId(models: readonly ModelInfo[]): string | undefined {
  return models.find((model) => model.isDefault)?.id ?? models[0]?.id;
}

function failedOrCancelled(
  abort: AbortController,
  error: unknown,
): "failed" | "cancelled" {
  if (abort.signal.aborted) {
    return "cancelled";
  }
  return normalizeError(error).kind === "cancelled" ? "cancelled" : "failed";
}

function hostOf(baseUrl: string): string {
  try {
    return new URL(baseUrl).host;
  } catch {
    return redactEndpoint(baseUrl);
  }
}

function forwardingLogger(current: () => Logger | null): Logger {
  const logger: Logger = {
    debug: (message, fields) => current()?.debug(message, fields),
    info: (message, fields) => current()?.info(message, fields),
    warn: (message, fields) => current()?.warn(message, fields),
    error: (message, fields) => current()?.error(message, fields),
    child: (category) => current()?.child(category) ?? logger,
  };
  return logger;
}
