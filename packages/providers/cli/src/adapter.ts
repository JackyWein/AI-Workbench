import type {
  AuthStatus,
  InstallationStatus,
  ModelInfo,
  ProviderCapabilities,
  ProviderEvent,
  ProviderErrorKind,
  ProviderMetadata,
  ProviderUsageSnapshot,
  UsageLimit,
} from "@ai-workbench/shared";
import {
  ProviderError,
  type AIProviderAdapter,
  type AgentMessage,
  type ProviderContext,
  type ProviderSessionConfig,
  type ProviderSessionHandle,
  type ProviderSessionInfo,
} from "@ai-workbench/provider-base";
import { CliTransport, type CliRun } from "@ai-workbench/transport-cli";
import {
  readPath,
  substitute,
  type CliProviderProfile,
  type JsonRule,
  type UsageLimitRule,
} from "./profile.js";

/** Marks a session the CLI has not assigned its own id to yet. */
const PENDING_PREFIX = "pending:";

export function isPendingSessionId(value: string): boolean {
  return value.startsWith(PENDING_PREFIX);
}

interface RunState {
  run: CliRun | null;
  cancelled: boolean;
}

/**
 * One adapter that serves every CLI-backed provider, driven by a profile
 * (spec §11, §12, §16). It contains no provider names: what differs between
 * providers is data, and what is the same — process lifecycle, streaming,
 * cancellation, error normalization — is implemented once and tested once.
 */
export class CliProviderAdapter implements AIProviderAdapter {
  readonly metadata: ProviderMetadata;
  readonly #profile: CliProviderProfile;
  readonly #runs = new Map<string, RunState>();
  /** Working directory per session, captured when the session is opened. */
  readonly #workingDirectories = new Map<string, string>();

  #transport: CliTransport | null = null;
  #context: ProviderContext | null = null;

  /** Present only when the profile claims the usage capability (spec §56). */
  getUsage?: () => Promise<ProviderUsageSnapshot>;

  /**
   * A command line provider cannot be polled for usage without paying for a
   * turn, so what it reports during a turn is remembered and served from here.
   */
  #lastUsage: ProviderUsageSnapshot | null = null;

  constructor(profile: CliProviderProfile) {
    this.#profile = profile;

    if (profile.capabilities.includes("usage")) {
      this.getUsage = async (): Promise<ProviderUsageSnapshot> =>
        this.#lastUsage ?? {
          providerId: profile.id,
          state: "unavailable",
          limits: [],
          updatedAt: new Date(),
          source: "cli",
          note: "Usage is reported during a turn; none has run yet.",
        };
    }
    this.metadata = {
      id: profile.id,
      displayName: profile.displayName,
      ...(profile.description === undefined
        ? {}
        : { description: profile.description }),
      adapterVersion: "1.0.0",
      ...(profile.website === undefined ? {} : { website: profile.website }),
      ...(profile.unverified
        ? {
            notice:
              "These command line flags are a starting point and have not been " +
              "verified against the installed tool. If a turn fails, correct the " +
              "path and arguments in this provider's settings.",
          }
        : {}),
      authMethods: [profile.auth.method],
      transportTypes: ["cli"],
    };
  }

  get profile(): CliProviderProfile {
    return this.#profile;
  }

  async initialize(context: ProviderContext): Promise<void> {
    this.#context = context;
    const config = context.config;

    this.#transport = new CliTransport({
      command: this.#profile.command,
      configuredPath: config.executablePath,
      baseArgs: config.arguments ?? [],
      env: { ...this.#profile.env, ...(config.environmentVariables ?? {}) },
      defaultTimeoutMs: this.#profile.timeoutMs,
      logger: context.logger,
    });
  }

  async dispose(): Promise<void> {
    for (const state of this.#runs.values()) {
      state.run?.cancel();
    }
    this.#runs.clear();
    this.#workingDirectories.clear();
    this.#transport = null;
  }

  async detectInstallation(): Promise<InstallationStatus> {
    const transport = this.#requireTransport();
    const executablePath = await transport.locate(true);
    if (!executablePath) {
      return {
        state: "notInstalled",
        detail: `"${this.#profile.command}" was not found on PATH`,
      };
    }

    const probe = await transport.version(this.#profile.versionArgs);
    return {
      state: "installed",
      executablePath,
      ...(probe?.version ? { version: probe.version } : {}),
      ...(probe && !probe.ok
        ? { detail: "The executable was found but did not report a version" }
        : {}),
    };
  }

  async getAuthenticationStatus(): Promise<AuthStatus> {
    const auth = this.#profile.auth;
    if (auth.method === "none") {
      return { state: "notApplicable", method: "none" };
    }

    const transport = this.#requireTransport();
    if (!(await transport.locate())) {
      return {
        state: "unknown",
        method: auth.method,
        detail: "The command line tool is not installed",
      };
    }

    if (!auth.probeArgs) {
      // Without a probe the CLI's own session is the source of truth and we do
      // not guess: an unknown state is reported honestly (spec §14).
      return {
        state: "unknown",
        method: auth.method,
        ...(auth.loginHint === undefined ? {} : { detail: auth.loginHint }),
      };
    }

    try {
      const { stdout, exit } = await this.#requireTransport().exec({
        args: auth.probeArgs,
        timeoutMs: 15_000,
      });
      const output = `${stdout}\n${exit.stderr}`;

      if (auth.unauthenticatedPattern && new RegExp(auth.unauthenticatedPattern, "i").test(output)) {
        return {
          state: "authenticationRequired",
          method: auth.method,
          ...(auth.loginHint === undefined ? {} : { detail: auth.loginHint }),
        };
      }
      if (auth.authenticatedPattern && new RegExp(auth.authenticatedPattern, "i").test(output)) {
        return { state: "authenticated", method: auth.method };
      }
      return exit.code === 0
        ? { state: "authenticated", method: auth.method }
        : {
            state: "authenticationRequired",
            method: auth.method,
            ...(auth.loginHint === undefined ? {} : { detail: auth.loginHint }),
          };
    } catch (error) {
      return {
        state: "unknown",
        method: auth.method,
        detail: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async getCapabilities(): Promise<ProviderCapabilities> {
    return { supported: [...this.#profile.capabilities] };
  }

  async listModels(): Promise<ModelInfo[]> {
    const configured = this.#context?.config.settings?.["models"];
    if (Array.isArray(configured) && configured.length > 0) {
      // A user-supplied list replaces the profile defaults, which can go stale.
      return configured as ModelInfo[];
    }
    return this.#profile.models.map((model) => ({ ...model }));
  }

  async createSession(config: ProviderSessionConfig): Promise<ProviderSessionInfo> {
    const resumable = this.#profile.resumeArgs.length > 0;
    this.#runs.set(config.sessionId, { run: null, cancelled: false });
    this.#workingDirectories.set(config.sessionId, config.workingDirectory);
    return {
      // The CLI assigns the real id on the first turn; until then this marks the
      // session as "not started", so no resume flag is passed.
      providerSessionId: `${PENDING_PREFIX}${config.sessionId}`,
      resumable,
      ...(config.modelId ? { modelId: config.modelId } : {}),
    };
  }

  async resumeSession(
    providerSessionId: string,
    config: ProviderSessionConfig,
  ): Promise<ProviderSessionInfo> {
    this.#runs.set(config.sessionId, { run: null, cancelled: false });
    this.#workingDirectories.set(config.sessionId, config.workingDirectory);
    return {
      providerSessionId,
      resumable: this.#profile.resumeArgs.length > 0,
      ...(config.modelId ? { modelId: config.modelId } : {}),
    };
  }

  async *sendMessage(
    session: ProviderSessionHandle,
    message: AgentMessage,
  ): AsyncIterable<ProviderEvent> {
    const transport = this.#requireTransport();
    const state: RunState = { run: null, cancelled: false };
    this.#runs.set(session.sessionId, state);

    const invocation = this.#buildInvocation(session, message);
    let run: CliRun;
    try {
      run = await transport.start(invocation);
    } catch (error) {
      yield {
        type: "error",
        error:
          error instanceof ProviderError
            ? error.toNormalized()
            : {
                kind: "transport",
                message: error instanceof Error ? error.message : String(error),
                retryable: false,
              },
      };
      yield { type: "completed", reason: "failed" };
      return;
    }
    state.run = run;

    let sawError = false;
    let producedText = false;

    try {
      for await (const line of run.lines) {
        for (const event of this.#parseLine(line)) {
          if (event.type === "error") {
            sawError = true;
          }
          if (event.type === "text_delta" || event.type === "message") {
            producedText = true;
          }
          yield event;
        }
      }
    } catch (error) {
      yield {
        type: "error",
        error: {
          kind: "transport",
          message: error instanceof Error ? error.message : String(error),
          retryable: true,
        },
      };
      yield { type: "completed", reason: "failed" };
      return;
    } finally {
      state.run = null;
    }

    const exit = await run.completion;

    if (exit.cancelled || state.cancelled) {
      yield { type: "completed", reason: "cancelled" };
      return;
    }

    if (exit.timedOut) {
      yield {
        type: "error",
        error: {
          kind: "timeout",
          message: "The provider did not finish in time",
          retryable: true,
        },
      };
      yield { type: "completed", reason: "failed" };
      return;
    }

    if (exit.code !== 0 && !sawError) {
      yield {
        type: "error",
        error: {
          kind: this.#classify(exit.stderr),
          message: firstLine(exit.stderr) || `The provider exited with code ${exit.code}`,
          retryable: false,
          ...(exit.stderr.trim() ? { detail: exit.stderr.trim().slice(0, 2000) } : {}),
        },
      };
      yield { type: "completed", reason: "failed" };
      return;
    }

    if (sawError) {
      yield { type: "completed", reason: "failed" };
      return;
    }

    if (!producedText) {
      yield {
        type: "warning",
        message: "The provider finished without returning any output",
      };
    }
    yield { type: "completed", reason: "finished" };
  }

  async cancel(session: ProviderSessionHandle): Promise<void> {
    const state = this.#runs.get(session.sessionId);
    if (state) {
      state.cancelled = true;
      state.run?.cancel();
    }
  }

  async destroySession(session: ProviderSessionHandle): Promise<void> {
    const state = this.#runs.get(session.sessionId);
    state?.run?.cancel();
    this.#runs.delete(session.sessionId);
    this.#workingDirectories.delete(session.sessionId);
  }

  #buildInvocation(
    session: ProviderSessionHandle,
    message: AgentMessage,
  ): { args: string[]; cwd?: string; stdin?: string; timeoutMs: number } {
    const profile = this.#profile;
    const values: Record<string, string | undefined> = {
      model: session.modelId,
      prompt: message.text,
      sessionId: session.sessionId,
      providerSessionId: isPendingSessionId(session.providerSessionId)
        ? undefined
        : session.providerSessionId,
    };

    // Resume arguments resolve to nothing while the provider session id is
    // still pending, which is how a first turn avoids passing a resume flag.
    const resumeArgs =
      profile.resumeArgs.length > 0 ? substitute(profile.resumeArgs, values) : null;

    const args =
      resumeArgs && profile.resumeMode === "replace"
        ? [...resumeArgs]
        : [...(substitute(profile.args, values) ?? profile.args)];

    if (session.modelId && profile.modelArgs.length > 0) {
      args.push(...(substitute(profile.modelArgs, values) ?? []));
    }
    if (resumeArgs && profile.resumeMode === "append") {
      args.push(...resumeArgs);
    }
    if (profile.promptVia === "arg") {
      args.push(...(substitute(profile.promptArgs, values) ?? []));
    }

    return {
      args,
      cwd: this.#cwd(session),
      ...(profile.promptVia === "stdin" ? { stdin: message.text } : {}),
      timeoutMs: profile.timeoutMs,
    };
  }

  #cwd(session: ProviderSessionHandle): string | undefined {
    return this.#workingDirectories.get(session.sessionId);
  }

  *#parseLine(line: string): Iterable<ProviderEvent> {
    const output = this.#profile.output;

    if (output.format === "text") {
      yield { type: "text_delta", text: `${line}\n` };
      return;
    }

    let decoded: unknown;
    try {
      decoded = JSON.parse(line);
    } catch {
      if (output.ignoreUnparsable) {
        return;
      }
      yield { type: "warning", message: `Unexpected provider output: ${line.slice(0, 200)}` };
      return;
    }

    const rule = output.rules.find((candidate) => matches(decoded, candidate));
    if (!rule || rule.emit === "ignore") {
      return;
    }

    const value = rule.valueKey === undefined ? undefined : readPath(decoded, rule.valueKey);

    switch (rule.emit) {
      case "text_delta":
        if (typeof value === "string" && value.length > 0) {
          yield { type: "text_delta", text: value };
        }
        return;
      case "message":
        if (typeof value === "string") {
          yield { type: "message", text: value };
        }
        return;
      case "status":
        yield { type: "status", status: typeof value === "string" ? value : "working" };
        return;
      case "session":
        if (typeof value === "string" && value.length > 0) {
          yield { type: "session", providerSessionId: value, resumable: true };
        }
        return;
      case "usage": {
        const inputTokens = numberAt(decoded, rule.inputTokensKey);
        const outputTokens = numberAt(decoded, rule.outputTokensKey);
        const limits = rule.limits
          .map((limitRule) => buildLimit(decoded, limitRule))
          .filter((limit): limit is UsageLimit => limit !== null);

        if (limits.length > 0) {
          this.#lastUsage = {
            providerId: this.#profile.id,
            state: "available",
            limits,
            updatedAt: new Date(),
            source: "cli",
          };
        }

        yield {
          type: "usage",
          usage: {
            limits,
            ...(inputTokens === undefined ? {} : { inputTokens }),
            ...(outputTokens === undefined ? {} : { outputTokens }),
          },
        };
        return;
      }
      case "error":
        yield {
          type: "error",
          error: {
            kind: this.#classify(typeof value === "string" ? value : ""),
            message: typeof value === "string" && value ? value : "The provider reported an error",
            retryable: false,
          },
        };
        return;
    }
  }

  /** Maps provider text onto a normalized error kind (spec §13). */
  #classify(text: string): ProviderErrorKind {
    for (const entry of this.#profile.errorPatterns) {
      if (new RegExp(entry.pattern, "i").test(text)) {
        return entry.kind;
      }
    }
    if (/not logged in|unauthenticated|unauthorized|auth|login|credential/i.test(text)) {
      return "authentication";
    }
    if (/rate limit|quota|too many requests|429/i.test(text)) {
      return "rateLimit";
    }
    if (/timed? out|timeout/i.test(text)) {
      return "timeout";
    }
    if (/not found|no such file|enoent/i.test(text)) {
      return "notInstalled";
    }
    return "provider";
  }

  #requireTransport(): CliTransport {
    if (!this.#transport) {
      throw new ProviderError("provider", `Provider "${this.#profile.id}" is not initialized`);
    }
    return this.#transport;
  }
}

function matches(decoded: unknown, rule: JsonRule): boolean {
  return Object.entries(rule.when).every(
    ([path, expected]) => String(readPath(decoded, path) ?? "") === expected,
  );
}

/** Turns provider fields into a usage limit, or null when nothing is known. */
function buildLimit(decoded: unknown, rule: UsageLimitRule): UsageLimit | null {
  const utilization = numberAt(decoded, rule.utilizationKey);
  const resetsAt = dateAt(decoded, rule.resetsAtKey, rule.resetsAtUnit);

  if (utilization !== undefined) {
    const used = Math.round(Math.max(0, Math.min(1, utilization)) * 100);
    return {
      id: rule.id,
      label: rule.label,
      used,
      remaining: 100 - used,
      total: 100,
      unit: "percent",
      ...(resetsAt === undefined ? {} : { resetsAt }),
    };
  }

  const used = numberAt(decoded, rule.usedKey);
  const remaining = numberAt(decoded, rule.remainingKey);
  const total = numberAt(decoded, rule.totalKey);
  if (used === undefined && remaining === undefined && total === undefined) {
    return null;
  }

  return {
    id: rule.id,
    label: rule.label,
    unit: "requests",
    ...(used === undefined ? {} : { used }),
    ...(remaining === undefined ? {} : { remaining }),
    ...(total === undefined ? {} : { total }),
    ...(resetsAt === undefined ? {} : { resetsAt }),
  };
}

function dateAt(
  decoded: unknown,
  path: string | undefined,
  unit: UsageLimitRule["resetsAtUnit"],
): Date | undefined {
  if (path === undefined) {
    return undefined;
  }
  const value = readPath(decoded, path);
  if (unit === "iso") {
    if (typeof value !== "string") {
      return undefined;
    }
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? undefined : parsed;
  }
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }
  return new Date(unit === "seconds" ? value * 1000 : value);
}

function numberAt(decoded: unknown, path: string | undefined): number | undefined {
  if (path === undefined) {
    return undefined;
  }
  const value = readPath(decoded, path);
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function firstLine(text: string): string {
  return text.trim().split("\n")[0]?.trim() ?? "";
}
