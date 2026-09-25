import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import type {
  AuthStatus,
  InstallationStatus,
  ModelInfo,
  ProviderCapabilities,
  ProviderEvent,
  ProviderMetadata,
  ProviderUsageSnapshot,
} from "@ai-workbench/shared";
import {
  ProviderError,
  type AIProviderAdapter,
  type AgentMessage,
  type ProviderAccountRef,
  type ProviderFactory,
  type ProviderContext,
  type ProviderSessionConfig,
  type ProviderSessionHandle,
  type ProviderSessionInfo,
} from "@ai-workbench/provider-base";
import { buildMockReply, chunkText } from "./reply.js";
import { buildTeamReply, looksLikeTeamPrompt, teamWriteFor } from "./team-reply.js";

export interface MockProviderOptions {
  /** Delay between streamed chunks. Tests set 0. */
  readonly chunkDelayMs?: number;
  /** Simulated thinking time before the first chunk. */
  readonly startupDelayMs?: number;
  /** Requests the simulated account may spend per week. */
  readonly weeklyRequestLimit?: number;
  /** One more simulated account; the entry becomes `mock@<id>`. */
  readonly account?: ProviderAccountRef;
}

interface MockSessionState {
  readonly sessionId: string;
  /** Follows the model currently selected for the session. */
  modelId: string;
  turns: number;
  /** Cumulative tokens, so context information is real rather than invented. */
  contextTokens: number;
  /** What the application composed for this turn, kept so /context can show it. */
  systemInstructions: string;
  toolNames: string[];
  /** Where the session works; a team member's files are written here. */
  workingDirectory: string;
  /** Every prompt this session was sent, so /recall can say what it was given. */
  prompts: string[];
  abort: AbortController | null;
}

export const MOCK_PROVIDER_ID = "mock";

const MOCK_MODELS: ModelInfo[] = [
  {
    id: "mock-standard",
    displayName: "Mock Standard",
    description: "Balanced simulated model",
    contextWindow: 200_000,
    isDefault: true,
  },
  {
    id: "mock-fast",
    displayName: "Mock Fast",
    description: "Streams in larger chunks with shorter delays",
    contextWindow: 64_000,
  },
  {
    id: "mock-reasoning",
    displayName: "Mock Reasoning",
    description: "Emits additional planning status events",
    contextWindow: 400_000,
    capabilities: ["reasoningModes"],
  },
];

/**
 * A fully local provider used to build and test the application end to end
 * (spec §20). It simulates streaming, delays, status changes, tool calls,
 * errors, usage, session resume, model selection and context information.
 *
 * Magic words in a prompt drive the simulations, so failure paths are testable:
 *   /error    -> normalized provider error
 *   /tool     -> tool call plus tool result
 *   /slow     -> longer thinking time
 *   /context  -> repeats the instructions and tools it was actually given
 *   /recall   -> repeats every prompt this session was given
 *   /limit@id -> the entry `id` (like mock or mock@spare) reports that its
 *                account reached a limit, which resets five seconds later
 */
export class MockProviderAdapter implements AIProviderAdapter {
  readonly metadata: ProviderMetadata;

  readonly #options: Required<Omit<MockProviderOptions, "account">>;
  readonly #sessions = new Map<string, MockSessionState>();
  #requestsUsed = 0;
  #initialized = false;

  constructor(options: MockProviderOptions = {}) {
    const account = options.account;
    this.metadata = {
      id: account ? `${MOCK_PROVIDER_ID}@${account.id}` : MOCK_PROVIDER_ID,
      displayName: "Mock Provider",
      description: "Local simulation used for development and tests",
      adapterVersion: "1.0.0",
      providerVersion: "simulated",
      authMethods: ["none"],
      transportTypes: ["in-process"],
      ...(account
        ? { family: MOCK_PROVIDER_ID, account: { id: account.id, label: account.label, home: account.home } }
        : {}),
    };
    this.#options = {
      chunkDelayMs: options.chunkDelayMs ?? 24,
      startupDelayMs: options.startupDelayMs ?? 180,
      weeklyRequestLimit: options.weeklyRequestLimit ?? 250,
    };
  }

  async initialize(_context: ProviderContext): Promise<void> {
    this.#initialized = true;
  }

  async dispose(): Promise<void> {
    for (const session of this.#sessions.values()) {
      session.abort?.abort();
    }
    this.#sessions.clear();
    this.#initialized = false;
  }

  async detectInstallation(): Promise<InstallationStatus> {
    return {
      state: "installed",
      version: this.metadata.adapterVersion,
      detail: "Runs in-process; nothing to install",
    };
  }

  async getAuthenticationStatus(): Promise<AuthStatus> {
    return {
      state: "notApplicable",
      method: "none",
      detail: "The mock provider needs no account",
    };
  }

  async getCapabilities(): Promise<ProviderCapabilities> {
    return {
      supported: [
        "chat",
        "streaming",
        "sessionResume",
        "modelSelection",
        "toolCalls",
        "usage",
        "contextInformation",
        "attachments",
      ],
    };
  }

  async listModels(): Promise<ModelInfo[]> {
    return MOCK_MODELS.map((model) => ({ ...model }));
  }

  async createSession(config: ProviderSessionConfig): Promise<ProviderSessionInfo> {
    this.#assertInitialized();
    const modelId = this.#resolveModelId(config.modelId);
    const providerSessionId = `mock-${config.sessionId}`;
    this.#sessions.set(providerSessionId, {
      sessionId: config.sessionId,
      modelId,
      turns: 0,
      contextTokens: 0,
      ...describeGiven(config),
      prompts: [],
      abort: null,
    });
    return { providerSessionId, resumable: true, modelId };
  }

  async resumeSession(
    providerSessionId: string,
    config: ProviderSessionConfig,
  ): Promise<ProviderSessionInfo> {
    this.#assertInitialized();
    const modelId = this.#resolveModelId(config.modelId);
    const existing = this.#sessions.get(providerSessionId);
    if (existing) {
      existing.abort = null;
      // A resumed session follows the currently selected model, and the
      // instructions and tools the application composed for this turn.
      existing.modelId = modelId;
      const given = describeGiven(config);
      existing.systemInstructions = given.systemInstructions;
      existing.toolNames = given.toolNames;
      existing.workingDirectory = given.workingDirectory;
      return { providerSessionId, resumable: true, modelId };
    }
    // A restarted app resumes a session this process has never seen; the mock
    // provider accepts it and continues, mirroring a CLI with durable sessions.
    this.#sessions.set(providerSessionId, {
      sessionId: config.sessionId,
      modelId,
      turns: 0,
      contextTokens: 0,
      ...describeGiven(config),
      prompts: [],
      abort: null,
    });
    return { providerSessionId, resumable: true, modelId };
  }

  async *sendMessage(
    session: ProviderSessionHandle,
    message: AgentMessage,
  ): AsyncIterable<ProviderEvent> {
    this.#assertInitialized();
    const state = this.#sessions.get(session.providerSessionId);
    if (!state) {
      throw new ProviderError("protocol", "Unknown mock session", {
        detail: session.providerSessionId,
      });
    }

    const abort = new AbortController();
    state.abort = abort;
    state.turns += 1;
    this.#requestsUsed += 1;

    const prompt = message.text;
    const modelId = session.modelId ?? state.modelId;
    state.prompts.push(prompt);
    // Magic words count in the new message only, never in an earlier
    // conversation handed over with it.
    const asked = withoutHandover(prompt);

    try {
      yield { type: "session", providerSessionId: session.providerSessionId, resumable: true };
      yield { type: "status", status: "thinking", detail: "Preparing response" };

      const startupDelay = asked.includes("/slow")
        ? this.#options.startupDelayMs * 4
        : this.#options.startupDelayMs;
      await delay(startupDelay, abort.signal);

      if (asked.includes("/error")) {
        yield {
          type: "error",
          error: {
            kind: "provider",
            message: "Simulated provider failure",
            retryable: true,
            detail: "Triggered by /error in the prompt",
          },
        };
        yield { type: "completed", reason: "failed" };
        return;
      }

      if (limitedEntries(asked).includes(this.metadata.id)) {
        yield {
          type: "error",
          error: {
            kind: "rateLimit",
            message: "Simulated account limit reached",
            retryable: false,
            detail: `Triggered by /limit@${this.metadata.id} in the prompt`,
            resetsAt: new Date(Date.now() + 5_000),
          },
        };
        yield { type: "completed", reason: "failed" };
        return;
      }

      if (asked.includes("/tool")) {
        const toolCall = {
          id: `tool-${state.turns}`,
          name: "filesystem",
          summary: "2 files read",
          state: "running" as const,
          input: { paths: ["README.md", "package.json"] },
        };
        yield { type: "tool_call", toolCall };
        await delay(this.#options.chunkDelayMs * 4, abort.signal);
        yield {
          type: "tool_result",
          toolCall: {
            ...toolCall,
            state: "completed",
            output: { bytesRead: 2048 },
          },
        };
      }

      // A team member asked to write a file does, inside its own folder only.
      const write = looksLikeTeamPrompt(prompt) ? teamWriteFor(prompt) : null;
      if (write && state.workingDirectory) {
        const root = resolve(state.workingDirectory);
        const target = resolve(root, write.path);
        if (target.startsWith(`${root}${sep}`)) {
          await mkdir(dirname(target), { recursive: true });
          await writeFile(target, write.content, "utf8");
        }
      }

      if (modelId === "mock-reasoning") {
        yield { type: "status", status: "planning", detail: "Outlining an answer" };
        await delay(this.#options.chunkDelayMs * 2, abort.signal);
      }

      yield { type: "status", status: "streaming" };

      const reply = asked.includes("/context")
        ? describeSessionContext(state)
        : asked.includes("/recall")
          ? `Given so far:\n\n${state.prompts.join("\n\n---\n\n")}`
          : // A team prompt gets a team answer, so Team Mode can be exercised
          // end to end without spending an account (spec §20).
          looksLikeTeamPrompt(prompt)
          ? buildTeamReply(prompt)
          : buildMockReply(prompt, modelId, message.attachments);
      const chunkSize = modelId === "mock-fast" ? 6 : 3;
      const chunkDelay =
        modelId === "mock-fast"
          ? Math.floor(this.#options.chunkDelayMs / 2)
          : this.#options.chunkDelayMs;

      for (const chunk of chunkText(reply, chunkSize)) {
        await delay(chunkDelay, abort.signal);
        yield { type: "text_delta", text: chunk };
      }

      const inputTokens = estimateTokens(prompt);
      const outputTokens = estimateTokens(reply);
      state.contextTokens += inputTokens + outputTokens;

      yield {
        type: "usage",
        usage: {
          limits: this.#buildLimits(),
          inputTokens,
          outputTokens,
          contextTokens: state.contextTokens,
          ...(contextWindowOf(modelId) === undefined
            ? {}
            : { contextWindow: contextWindowOf(modelId) }),
        },
      };
      yield { type: "completed", reason: "finished" };
    } catch (error) {
      if (isAbort(error)) {
        yield { type: "completed", reason: "cancelled" };
        return;
      }
      throw error;
    } finally {
      state.abort = null;
    }
  }

  async cancel(session: ProviderSessionHandle): Promise<void> {
    this.#sessions.get(session.providerSessionId)?.abort?.abort();
  }

  async destroySession(session: ProviderSessionHandle): Promise<void> {
    const state = this.#sessions.get(session.providerSessionId);
    state?.abort?.abort();
    this.#sessions.delete(session.providerSessionId);
  }

  async getUsage(): Promise<ProviderUsageSnapshot> {
    return {
      providerId: this.metadata.id,
      state: "available",
      limits: this.#buildLimits(),
      updatedAt: new Date(),
      source: "provider",
    };
  }

  #buildLimits() {
    const total = this.#options.weeklyRequestLimit;
    const used = Math.min(this.#requestsUsed, total);
    return [
      {
        id: "weekly-requests",
        label: "Weekly",
        used,
        remaining: total - used,
        total,
        unit: "requests" as const,
        resetsAt: nextWeeklyReset(),
      },
    ];
  }

  #resolveModelId(modelId: string | undefined): string {
    if (modelId && MOCK_MODELS.some((model) => model.id === modelId)) {
      return modelId;
    }
    const fallback = MOCK_MODELS.find((model) => model.isDefault) ?? MOCK_MODELS[0];
    if (!fallback) {
      throw new ProviderError("provider", "Mock provider has no models");
    }
    return fallback.id;
  }

  #assertInitialized(): void {
    if (!this.#initialized) {
      throw new ProviderError("provider", "Mock provider is not initialized");
    }
  }
}

/**
 * A prompt without the earlier conversation the application handed over. It
 * comes first, and may itself quote an earlier handover, so it runs to the
 * last closing tag.
 */
function withoutHandover(prompt: string): string {
  return prompt.replace(/^\s*<conversation-so-far>[\s\S]*<\/conversation-so-far>/, "");
}

/** The entries a prompt tells to hit their limit, from "/limit@<entry id>". */
function limitedEntries(prompt: string): string[] {
  return [...prompt.matchAll(/\/limit@(\S+)/g)].map((match) => match[1] ?? "");
}

/**
 * The simulated provider as a family: its default entry and further
 * simulated accounts, so switching accounts can be exercised end to end.
 */
export function mockProviderFactory(options: Omit<MockProviderOptions, "account"> = {}): ProviderFactory {
  return {
    family: MOCK_PROVIDER_ID,
    displayName: "Mock Provider",
    accounts: {
      detect: async () => [],
      isDefaultHome: () => false,
    },
    create: (account) => new MockProviderAdapter({ ...options, ...(account ? { account } : {}) }),
  };
}

function contextWindowOf(modelId: string): number | undefined {
  return MOCK_MODELS.find((model) => model.id === modelId)?.contextWindow;
}

function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

function nextWeeklyReset(): Date {
  const reset = new Date();
  reset.setUTCDate(reset.getUTCDate() + (7 - reset.getUTCDay()));
  reset.setUTCHours(0, 0, 0, 0);
  return reset;
}

function isAbort(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return Promise.reject(abortError());
  }
  if (ms <= 0) {
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(abortError());
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function abortError(): Error {
  const error = new Error("Cancelled");
  error.name = "AbortError";
  return error;
}

/** What the application handed this session, in the shape the state keeps. */
function describeGiven(config: ProviderSessionConfig): {
  systemInstructions: string;
  toolNames: string[];
  workingDirectory: string;
} {
  return {
    systemInstructions: config.systemInstructions ?? "",
    toolNames: (config.toolAccess?.hostTools ?? []).map((tool) => tool.name),
    workingDirectory: config.workingDirectory,
  };
}

/**
 * Repeats what the application actually composed for this session, so a check
 * can prove that skills and tools reached the provider instead of assuming it.
 */
function describeSessionContext(state: MockSessionState): string {
  const instructions = state.systemInstructions.trim();
  const lines = [
    instructions.length > 0
      ? `Instructions received:\n${instructions}`
      : "Instructions received: none",
    state.toolNames.length > 0
      ? `Tools available: ${state.toolNames.join(", ")}`
      : "Tools available: none",
  ];
  return lines.join("\n\n");
}
