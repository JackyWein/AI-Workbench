import {
  authStatusSchema,
  type AuthStatus,
  type InstallationStatus,
  type Logger,
  type ModelInfo,
  type ProviderCapabilities,
  type ProviderConfig,
  type ProviderEvent,
  type ProviderMetadata,
  type ProviderUsageSnapshot,
} from "@ai-workbench/shared";
import {
  ProviderError,
  type AIProviderAdapter,
  type AgentMessage,
  type InteractiveLaunch,
  type InteractiveLaunchRequest,
  type ProviderContext,
  type ProviderImportables,
  type ProviderSessionConfig,
  type ProviderSessionHandle,
  type ProviderSessionInfo,
  type ProviderToolAccess,
} from "@ai-workbench/provider-base";
import { CliTransport, expandPath, type CliRun } from "@ai-workbench/transport-cli";
import { TimedCache } from "./cache.js";
import { createExtensionContext, runHook } from "./extension-context.js";
import type {
  CliExtensionContext,
  CliParseState,
  CliProviderExtensions,
} from "./extensions.js";
import { buildInteractiveArgs, buildTurnArgs } from "./invocation.js";
import { buildMcpLaunch, mcpServersFor, NO_MCP, type CliMcpLaunch } from "./mcp.js";
import { ModelStore, parseModelLines, validModels } from "./models.js";
import { classifyError, parseWithRules } from "./parse.js";
import type { CliProviderProfile } from "./profile.js";
import { UsageStore } from "./usage.js";

/** One account of a tool that keeps several side by side. */
export interface CliAccount {
  /** Stable id; the provider entry becomes `<profile id>@<account id>`. */
  readonly id: string;
  readonly label: string;
  /** The tool's configuration home for this account; null is its default. */
  readonly home: string | null;
}

export interface CliAdapterOptions {
  /** Provider-specific knowledge that is code rather than profile data. */
  readonly extensions?: CliProviderExtensions;
  /** Present when this entry is one of several accounts of the tool. */
  readonly account?: CliAccount;
}

/** Marks a session the CLI has not assigned its own id to yet. */
const PENDING_PREFIX = "pending:";

export function isPendingSessionId(value: string): boolean {
  return value.startsWith(PENDING_PREFIX);
}

/**
 * How long facts that cost a process to learn are trusted (spec §108): the
 * provider list asks for them on every refresh.
 */
const INSTALLATION_TTL_MS = 60_000;
const AUTH_TTL_MS = 2 * 60_000;

/** The longest an extension hook may take before its answer is treated as null. */
const HOOK_TIMEOUT_MS = {
  discoverModels: 60_000,
  readUsage: 60_000,
  probeAuth: 30_000,
  discoverImportables: 60_000,
} as const;

interface RunState {
  run: CliRun | null;
  cancelled: boolean;
}

/** What a session was opened with that a turn's handle does not carry. */
interface SessionSetup {
  readonly workingDirectory: string;
  readonly systemInstructions: string | undefined;
  readonly toolAccess: ProviderToolAccess | undefined;
}

/**
 * One adapter that serves every CLI-backed provider, driven by a profile
 * (spec §11, §12, §16). It contains no provider names: what differs between
 * providers is data, or code in the provider's own package handed in as
 * extensions, and what is the same — process lifecycle, streaming,
 * cancellation, caching, error normalization — is implemented once and
 * tested once.
 */
export class CliProviderAdapter implements AIProviderAdapter {
  readonly metadata: ProviderMetadata;
  readonly #profile: CliProviderProfile;
  readonly #options: CliAdapterOptions;
  readonly #extensions: CliProviderExtensions;
  readonly #capabilities: ProviderCapabilities["supported"];
  readonly #runs = new Map<string, RunState>();
  readonly #sessions = new Map<string, SessionSetup>();
  readonly #installation = new TimedCache<InstallationStatus>(INSTALLATION_TTL_MS);
  readonly #auth = new TimedCache<AuthStatus>(AUTH_TTL_MS);
  /** Logs through the context's logger, which only exists once initialized. */
  readonly #logger: Logger = forwardingLogger(() => this.#context?.logger ?? null);
  readonly #models: ModelStore;
  readonly #usage: UsageStore;

  #transport: CliTransport | null = null;
  #context: ProviderContext | null = null;
  #extensionContext: CliExtensionContext | null = null;
  /** The environment every run of this entry gets on top of the inherited one. */
  #env: Record<string, string> = {};

  /** Present when the tool can report usage at all (spec §56). */
  getUsage?: () => Promise<ProviderUsageSnapshot>;

  /** Present when the tool has its own interactive interface (spec §26). */
  describeInteractiveLaunch?: (request: InteractiveLaunchRequest) => Promise<InteractiveLaunch>;

  constructor(profile: CliProviderProfile, options: CliAdapterOptions = {}) {
    this.#profile = profile;
    this.#options = options;
    this.#extensions = options.extensions ?? {};
    const account = options.account;
    const id = account ? `${profile.id}@${account.id}` : profile.id;

    this.#capabilities = deriveCapabilities(profile, this.#extensions);
    this.#models = new ModelStore(this.#logger, () => this.#notifyChanged());
    this.#usage = new UsageStore({
      providerId: id,
      logger: this.#logger,
      read: this.#extensions.readUsage
        ? () =>
            this.#runExtension("readUsage", HOOK_TIMEOUT_MS.readUsage, (extensions, context) =>
              extensions.readUsage?.(context) ?? Promise.resolve(null),
            )
        : undefined,
      onChange: () => this.#notifyChanged(),
    });

    if (this.#capabilities.includes("usage")) {
      this.getUsage = () => this.#usage.get();
    }
    if (profile.interactive) {
      this.describeInteractiveLaunch = (request) => this.#describeInteractiveLaunch(request);
    }

    this.metadata = {
      id,
      displayName: profile.displayName,
      ...(profile.description === undefined ? {} : { description: profile.description }),
      adapterVersion: "1.0.0",
      ...(profile.icon === undefined ? {} : { icon: profile.icon }),
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
      family: profile.id,
      ...(account === undefined
        ? {}
        : { account: { id: account.id, label: account.label, home: account.home } }),
    };
  }

  get profile(): CliProviderProfile {
    return this.#profile;
  }

  async initialize(context: ProviderContext): Promise<void> {
    this.#context = context;
    const config = context.config;
    this.#env = this.#instanceEnv(config);

    const transport = new CliTransport({
      command: this.#profile.command,
      configuredPath: config.executablePath,
      knownLocations: this.#profile.knownLocations,
      baseArgs: config.arguments ?? [],
      env: this.#env,
      defaultTimeoutMs: this.#profile.timeoutMs,
      logger: context.logger,
    });
    this.#transport = transport;
    this.#installation.clear();
    this.#auth.clear();
    this.#usage.reset();

    this.#extensionContext = createExtensionContext({
      profile: this.#profile,
      providerId: this.metadata.id,
      logger: context.logger,
      stateDirectory: context.stateDirectory,
      env: this.#env,
      accountHome: this.#accountHome(),
      transport,
    });

    if (this.#extensions.discoverModels || this.#profile.modelsArgs.length > 0) {
      // The last known list is served at once; asking the tool again takes a
      // process start and must not hold up the application's startup.
      await this.#models.load(context.stateDirectory);
      void this.#discoverModels();
    }
  }

  async dispose(): Promise<void> {
    for (const state of this.#runs.values()) {
      state.run?.cancel();
    }
    this.#runs.clear();
    this.#sessions.clear();
    this.#transport = null;
    this.#extensionContext = null;
    this.#installation.clear();
    this.#auth.clear();
    this.#models.reset();
    this.#usage.reset();
  }

  async detectInstallation(): Promise<InstallationStatus> {
    const transport = this.#requireTransport();
    return this.#installation.get(async () => {
      const executablePath = await transport.locate(true);
      if (!executablePath) {
        return {
          state: "notInstalled",
          detail:
            this.#profile.knownLocations.length > 0
              ? `"${this.#profile.command}" was not found on PATH or where it is usually installed`
              : `"${this.#profile.command}" was not found on PATH`,
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
    });
  }

  async getAuthenticationStatus(): Promise<AuthStatus> {
    const auth = this.#profile.auth;
    if (auth.method === "none") {
      return { state: "notApplicable", method: "none" };
    }

    const transport = this.#requireTransport();
    // Not cached: installing the tool must show up without waiting.
    if (!(await transport.locate())) {
      return {
        state: "unknown",
        method: auth.method,
        detail: "The command line tool is not installed",
      };
    }

    return this.#auth.get(async () => {
      if (this.#extensions.probeAuth) {
        const probed = await this.#runExtension(
          "probeAuth",
          HOOK_TIMEOUT_MS.probeAuth,
          (extensions, context) => extensions.probeAuth?.(context) ?? Promise.resolve(null),
        );
        const parsed = probed === null ? null : authStatusSchema.safeParse(probed);
        if (parsed?.success) {
          return parsed.data;
        }
      }
      return this.#probeAuthWithProfile(transport);
    });
  }

  async getCapabilities(): Promise<ProviderCapabilities> {
    return { supported: [...this.#capabilities] };
  }

  async listModels(): Promise<ModelInfo[]> {
    return this.#models.list(
      validModels(this.#context?.config.settings?.["models"]).map((model) => ({
        ...model,
        source: "user",
      })),
      this.#profile.models,
    );
  }

  async refreshModels(): Promise<ModelInfo[]> {
    await this.#discoverModels();
    return this.listModels();
  }

  getModelsUpdatedAt(): Date | null {
    return this.#models.updatedAt;
  }

  async discoverImportables(request: { workspacePath?: string }): Promise<ProviderImportables> {
    const found = await this.#runExtension(
      "discoverImportables",
      HOOK_TIMEOUT_MS.discoverImportables,
      (extensions, context) =>
        extensions.discoverImportables?.(context, request) ?? Promise.resolve(null),
    );
    return found ?? { skills: [], mcpServers: [] };
  }

  async createSession(config: ProviderSessionConfig): Promise<ProviderSessionInfo> {
    this.#openSession(config);
    return {
      // The CLI assigns the real id on the first turn; until then this marks the
      // session as "not started", so no resume flag is passed.
      providerSessionId: `${PENDING_PREFIX}${config.sessionId}`,
      resumable: this.#profile.resumeArgs.length > 0,
      ...(config.modelId ? { modelId: config.modelId } : {}),
    };
  }

  async resumeSession(
    providerSessionId: string,
    config: ProviderSessionConfig,
  ): Promise<ProviderSessionInfo> {
    this.#openSession(config);
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
    const profile = this.#profile;
    const state: RunState = { run: null, cancelled: false };
    this.#runs.set(session.sessionId, state);

    const setup = this.#sessions.get(session.sessionId);
    const mcp = this.#mcpLaunch(setup?.toolAccess);
    if (mcp.warning) {
      yield { type: "warning", message: mcp.warning };
    }

    const args = buildTurnArgs(profile, {
      prompt: message.text,
      sessionId: session.sessionId,
      // Resume arguments resolve to nothing while the provider session id is
      // still pending, which is how a first turn avoids passing a resume flag.
      providerSessionId: isPendingSessionId(session.providerSessionId)
        ? undefined
        : session.providerSessionId,
      modelId: session.modelId,
      reasoningEffort: session.reasoningEffort,
      permissionMode: session.permissionMode,
      systemInstructions: setup?.systemInstructions,
      workingDirectory: setup?.workingDirectory,
      mcp: mcp.launch,
    });

    let run: CliRun;
    try {
      run = await transport.start({
        args,
        cwd: setup?.workingDirectory,
        ...(profile.promptVia === "stdin" ? { stdin: message.text } : {}),
        timeoutMs: profile.timeoutMs,
        ...(Object.keys(mcp.launch.env).length > 0 ? { env: mcp.launch.env } : {}),
      });
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
    if (state.cancelled) {
      // Cancelled while the process was being started.
      run.cancel();
    }

    const parseState: CliParseState = { values: new Map() };
    let sawError = false;
    let producedText = false;

    try {
      for await (const line of run.lines) {
        for (const event of this.#parseLine(line, parseState)) {
          if (event.type === "error") {
            sawError = true;
          }
          if (event.type === "text_delta" || event.type === "message") {
            producedText = true;
          }
          if (event.type === "usage" && event.usage.limits.length > 0) {
            // A turn is also a fresh reading of the account's limits.
            this.#usage.observeTurn(event.usage.limits);
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
          kind: classifyError(profile, exit.stderr),
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
    this.#sessions.delete(session.sessionId);
  }

  #openSession(config: ProviderSessionConfig): void {
    this.#runs.set(config.sessionId, { run: null, cancelled: false });
    this.#sessions.set(config.sessionId, {
      workingDirectory: config.workingDirectory,
      systemInstructions: config.systemInstructions,
      toolAccess: config.toolAccess,
    });
  }

  async #describeInteractiveLaunch(request: InteractiveLaunchRequest): Promise<InteractiveLaunch> {
    const transport = this.#requireTransport();
    const command = await transport.locate();
    if (!command) {
      throw new ProviderError("notInstalled", `"${this.#profile.command}" was not found`, {
        detail: "Install the command line tool, or set its path in the provider settings.",
      });
    }

    const mcp = this.#mcpLaunch(request.toolAccess);
    if (mcp.warning) {
      this.#logger.warn(mcp.warning, { providerId: this.metadata.id });
    }
    return {
      command,
      args: [
        // Configured arguments come first on every run of the tool.
        ...(this.#context?.config.arguments ?? []),
        ...buildInteractiveArgs(this.#profile, {
          modelId: request.modelId,
          reasoningEffort: request.reasoningEffort,
          permissionMode: request.permissionMode,
          systemInstructions: request.systemInstructions,
          workingDirectory: request.workingDirectory,
          mcp: mcp.launch,
        }),
      ],
      env: { ...this.#env, ...mcp.launch.env },
      cwd: request.workingDirectory,
    };
  }

  /**
   * The MCP servers of a session, in the form the tool reads them. A failure
   * is reported, not hidden: the turn still runs, and the user learns why the
   * tools are missing (spec §60).
   */
  #mcpLaunch(toolAccess: ProviderToolAccess | undefined): {
    launch: CliMcpLaunch;
    warning?: string;
  } {
    const servers = mcpServersFor(toolAccess);
    if (servers.length === 0) {
      return { launch: NO_MCP };
    }
    const mcp = this.#profile.mcp;
    if (mcp.via !== "extension") {
      if (mcp.via === "none") {
        this.#logger.debug("The tool takes no MCP servers; none were passed", {
          providerId: this.metadata.id,
          servers: servers.length,
        });
      }
      return { launch: buildMcpLaunch(mcp, servers) };
    }

    const context = this.#extensionContext;
    const failed = (reason: string): { launch: CliMcpLaunch; warning: string } => ({
      launch: NO_MCP,
      warning: `The session's MCP servers could not be handed to the tool: ${reason}`,
    });
    if (!this.#extensions.mcpLaunch || !context) {
      return failed("its provider package does not say how.");
    }
    try {
      const launch = this.#extensions.mcpLaunch(servers, context);
      return { launch: { args: [...launch.args], env: { ...launch.env } } };
    } catch (error) {
      this.#logger.warn("Provider extension failed", {
        hook: "mcpLaunch",
        error: error instanceof Error ? error.message : String(error),
      });
      return failed(error instanceof Error ? error.message : String(error));
    }
  }

  /** The extension decodes a line when it wants to; the profile's rules otherwise. */
  #parseLine(line: string, state: CliParseState): ProviderEvent[] {
    if (this.#extensions.parseLine) {
      try {
        const events = this.#extensions.parseLine(line, state);
        if (events !== undefined) {
          return events;
        }
      } catch (error) {
        this.#logger.warn("Provider extension failed", {
          hook: "parseLine",
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return parseWithRules(this.#profile, line);
  }

  async #discoverModels(): Promise<void> {
    if (this.#extensions.discoverModels && this.#extensionContext) {
      await this.#models.refresh(() =>
        this.#runExtension("discoverModels", HOOK_TIMEOUT_MS.discoverModels, (extensions, context) =>
          extensions.discoverModels?.(context) ?? Promise.resolve(null),
        ),
      );
      return;
    }
    // Profile-driven discovery: the tool lists its own models, one id per
    // line. Without such a command the list stays manual (spec §21).
    if (this.#profile.modelsArgs.length === 0 || !this.#transport) {
      return;
    }
    const transport = this.#transport;
    const args = [...this.#profile.modelsArgs];
    await this.#models.refresh(async () => {
      try {
        const { stdout, exit } = await transport.exec({ args, timeoutMs: 30_000 });
        if (exit.code !== 0) {
          return null;
        }
        return parseModelLines(stdout);
      } catch {
        return null;
      }
    });
  }

  /** Runs a hook against this entry's context; null when not initialized or on failure. */
  async #runExtension<T>(
    hook: string,
    timeoutMs: number,
    call: (extensions: CliProviderExtensions, context: CliExtensionContext) => Promise<T | null>,
  ): Promise<T | null> {
    const context = this.#extensionContext;
    if (!context) {
      return null;
    }
    return runHook(this.#logger, hook, timeoutMs, () => call(this.#extensions, context));
  }

  /** The profile's own probe: a command whose output or exit code tells. */
  async #probeAuthWithProfile(transport: CliTransport): Promise<AuthStatus> {
    const auth = this.#profile.auth;
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
      const { stdout, exit } = await transport.exec({
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

  /**
   * The inherited environment is overridden by the profile's variables, those
   * by the account's configuration home, and all of them by what the user
   * configured. The default account leaves the home variable alone, so the
   * tool behaves exactly as it does in the user's own terminal.
   */
  #instanceEnv(config: ProviderConfig): Record<string, string> {
    const env: Record<string, string> = { ...this.#profile.env };
    const accounts = this.#profile.accounts;
    const home = this.#options.account?.home;
    if (accounts && home) {
      env[accounts.homeVariable] = expandPath(home) ?? home;
    }
    return { ...env, ...(config.environmentVariables ?? {}) };
  }

  /** The configuration home the tool will actually use for this entry. */
  #accountHome(): string | null {
    const accounts = this.#profile.accounts;
    if (!accounts) {
      return null;
    }
    const home = this.#options.account?.home;
    if (home) {
      return expandPath(home) ?? home;
    }
    // The default account: whatever already selects a home wins over the
    // tool's documented default, just as it would in a terminal.
    const selected = this.#env[accounts.homeVariable] ?? process.env[accounts.homeVariable];
    return selected || expandPath(accounts.defaultHome);
  }

  #notifyChanged(): void {
    try {
      this.#context?.notifyChanged?.();
    } catch (error) {
      this.#logger.debug("Change notification failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  #requireTransport(): CliTransport {
    if (!this.#transport) {
      throw new ProviderError("provider", `Provider "${this.metadata.id}" is not initialized`);
    }
    return this.#transport;
  }
}

/**
 * The profile's capabilities plus what its data and extensions imply, so a
 * profile cannot forget to declare what it evidently supports.
 */
function deriveCapabilities(
  profile: CliProviderProfile,
  extensions: CliProviderExtensions,
): ProviderCapabilities["supported"] {
  const supported = new Set(profile.capabilities);
  if (profile.effortArgs.length > 0) {
    supported.add("reasoningModes");
  }
  if (profile.interactive) {
    supported.add("interactiveTerminal");
  }
  if (profile.accounts) {
    supported.add("accounts");
  }
  if (extensions.readUsage) {
    supported.add("usage");
  }
  return [...supported];
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

function firstLine(text: string): string {
  return text.trim().split("\n")[0]?.trim() ?? "";
}
