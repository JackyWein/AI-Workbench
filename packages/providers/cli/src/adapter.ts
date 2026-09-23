import {
  authStatusSchema,
  type AuthStatus,
  type InstallationStatus,
  type Logger,
  type ModelInfo,
  type ProviderCapabilities,
  type ProviderConfig,
  type ProviderEvent,
  type ProviderIntegration,
  type ProviderMetadata,
  type ProviderUsageSnapshot,
} from "@ai-workbench/shared";
import {
  ProviderError,
  type AIProviderAdapter,
  type AgentMessage,
  type InteractiveLaunch,
  type InteractiveLaunchRequest,
  type InteractiveTelemetry,
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
  CliInteractiveTelemetry,
  CliParseState,
  CliProviderExtensions,
} from "./extensions.js";
import { buildInteractiveArgs, buildTurnArgs } from "./invocation.js";
import { buildMcpLaunch, mcpServersFor, NO_MCP, type CliMcpLaunch } from "./mcp.js";
import { ModelStore, parseModelLines, validModels } from "./models.js";
import { classifyError, parseWithRules } from "./parse.js";
import { readPath, type CliAuth, type CliProviderProfile } from "./profile.js";
import { UsageStore, parseOpencodeStatsUsage } from "./usage.js";

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
  interactiveTelemetry: 20_000,
  probeAuth: 30_000,
  integration: 30_000,
  discoverImportables: 60_000,
  adaptArgs: 20_000,
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
  /** Why the last model discovery produced nothing, when it did. */
  #modelsNote: string | null = null;
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

  /** Present when the tool has a sign-in command for its accounts (spec §14). */
  describeLogin?: () => Promise<InteractiveLaunch | null>;

  /** Present when the tool needs a one-time setup its package knows. */
  getIntegration?: () => Promise<ProviderIntegration | null>;
  describeIntegrationSetup?: () => Promise<InteractiveLaunch | null>;

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
        : this.#profile.usageArgs.length > 0 && this.#profile.usageFormat === "opencode-stats"
          ? () => this.#readUsageFromProfile()
          : undefined,
      onChange: () => this.#notifyChanged(),
    });

    if (this.#capabilities.includes("usage")) {
      this.getUsage = () => this.#usage.get();
    }
    if (profile.interactive) {
      this.describeInteractiveLaunch = (request) => this.#describeInteractiveLaunch(request);
    }
    if (profile.accounts && profile.accounts.loginArgs.length > 0) {
      this.describeLogin = () => this.#describeLogin();
    }
    if (this.#extensions.integration) {
      this.getIntegration = () =>
        this.#runExtension("integration.status", HOOK_TIMEOUT_MS.integration, (extensions, context) =>
          extensions.integration?.status(context) ?? Promise.resolve(null),
        );
      this.describeIntegrationSetup = () => this.#describeIntegrationSetup();
    }

    this.metadata = {
      id,
      displayName: profile.displayName,
      ...(profile.description === undefined ? {} : { description: profile.description }),
      adapterVersion: "1.0.0",
      ...(profile.icon === undefined ? {} : { icon: profile.icon }),
      ...(profile.effortOptions.length === 0 ? {} : { effortOptions: [...profile.effortOptions] }),
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
    await this.#usage.load(context.stateDirectory);

    this.#extensionContext = createExtensionContext({
      profile: this.#profile,
      providerId: this.metadata.id,
      logger: context.logger,
      stateDirectory: context.stateDirectory,
      env: this.#env,
      accountHome: this.#accountHome(),
      transport,
      version: async () => {
        const installation = await this.detectInstallation();
        return installation.state === "installed" ? (installation.version ?? null) : null;
      },
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

  /** Why the tool's own list is missing; cleared as soon as one is read. */
  getModelsNote(): string | null {
    return this.#modelsNote;
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
    // A turn must know where it works. Without this the child process would
    // inherit the application's own folder and write there — which is never
    // what the person asked for, so it is refused instead of guessed.
    if (!setup?.workingDirectory) {
      yield {
        type: "error",
        error: {
          kind: "protocol",
          message:
            "This turn has no working folder, so it was not started. Open the session's workspace again, or set the team's folder.",
          retryable: false,
        },
      };
      return;
    }
    const mcp = this.#mcpLaunch(setup.toolAccess);
    if (mcp.warning) {
      yield { type: "warning", message: mcp.warning };
    }

    const built = buildTurnArgs(profile, {
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
    const args = await this.#adaptArgs(built, "turn");

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
    const telemetry =
      this.#extensions.interactiveTelemetry && request.runId
        ? await this.#runExtension(
            "interactiveTelemetry",
            HOOK_TIMEOUT_MS.interactiveTelemetry,
            (extensions, context) =>
              extensions.interactiveTelemetry?.(context, {
                runId: request.runId ?? "",
                workingDirectory: request.workingDirectory,
                startedAt: request.startedAt ?? new Date(),
              }) ?? Promise.resolve(null),
          )
        : null;
    const args = await this.#adaptArgs(
      [
        // Configured arguments come first on every run of the tool.
        ...(this.#context?.config.arguments ?? []),
        ...(telemetry?.args ?? []),
        ...buildInteractiveArgs(this.#profile, {
          modelId: request.modelId,
          reasoningEffort: request.reasoningEffort,
          permissionMode: request.permissionMode,
          systemInstructions: request.systemInstructions,
          workingDirectory: request.workingDirectory,
          mcp: mcp.launch,
        }),
      ],
      "interactive",
    );
    return {
      command,
      args,
      env: { ...this.#env, ...mcp.launch.env, ...telemetry?.env },
      cwd: request.workingDirectory,
      ...(telemetry ? { telemetry: this.#forwardTelemetry(telemetry) } : {}),
    };
  }

  /** The tool's own sign-in, run against this entry's configuration home. */
  async #describeLogin(): Promise<InteractiveLaunch | null> {
    const loginArgs = this.#profile.accounts?.loginArgs ?? [];
    const command = await this.#transport?.locate();
    if (!command || loginArgs.length === 0) {
      return null;
    }
    return {
      command,
      args: [...(this.#context?.config.arguments ?? []), ...loginArgs],
      env: { ...this.#env },
      cwd: this.#accountHome() ?? process.cwd(),
    };
  }

  /** The tool's own setup command, run where the person answers its questions. */
  async #describeIntegrationSetup(): Promise<InteractiveLaunch | null> {
    const command = await this.#transport?.locate();
    const setupArgs = await this.#runExtension(
      "integration.setupArgs",
      HOOK_TIMEOUT_MS.integration,
      (extensions, context) => extensions.integration?.setupArgs(context) ?? Promise.resolve(null),
    );
    if (!command || !setupArgs) {
      return null;
    }
    return {
      command,
      args: [...(this.#context?.config.arguments ?? []), ...setupArgs],
      env: { ...this.#env },
      cwd: this.#context?.stateDirectory ?? process.cwd(),
    };
  }

  /**
   * Hands a run's metrics on, and lets the account limits it reports refresh
   * this entry's usage: a terminal is as good a witness as a turn.
   */
  #forwardTelemetry(telemetry: CliInteractiveTelemetry): InteractiveTelemetry {
    const failed = (hook: string, error: unknown): void => {
      this.#logger.warn("Provider extension failed", {
        hook,
        error: error instanceof Error ? error.message : String(error),
      });
    };
    const watchAttention = telemetry.watchAttention?.bind(telemetry);
    const watchActivity = telemetry.watchActivity?.bind(telemetry);
    const respond = telemetry.respond?.bind(telemetry);
    return {
      source: telemetry.source,
      watch: (onMetrics) => {
        try {
          return telemetry.watch((metrics) => {
            if (metrics.limits.length > 0) {
              this.#usage.observeTurn(metrics.limits, metrics.updatedAt);
            }
            onMetrics(metrics);
          });
        } catch (error) {
          failed("interactiveTelemetry.watch", error);
          return () => undefined;
        }
      },
      ...(watchAttention
        ? {
            watchAttention: (onAttention) => {
              try {
                return watchAttention(onAttention);
              } catch (error) {
                failed("interactiveTelemetry.watchAttention", error);
                return () => undefined;
              }
            },
          }
        : {}),
      ...(watchActivity
        ? {
            watchActivity: (onActivity) => {
              try {
                return watchActivity(onActivity);
              } catch (error) {
                failed("interactiveTelemetry.watchActivity", error);
                return () => undefined;
              }
            },
          }
        : {}),
      ...(respond
        ? {
            respond: async (attentionId, response, terminal) => {
              try {
                return await respond(attentionId, response, terminal);
              } catch (error) {
                failed("interactiveTelemetry.respond", error);
                return false;
              }
            },
          }
        : {}),
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
      await this.#models.refresh(async () => {
        // An extension that fails says why by throwing; the reason is kept
        // for the picker instead of an empty list without explanation.
        let reason: string | null = null;
        const models = await this.#runExtension(
          "discoverModels",
          HOOK_TIMEOUT_MS.discoverModels,
          async (extensions, context) => {
            try {
              return (await extensions.discoverModels?.(context)) ?? null;
            } catch (error) {
              reason = error instanceof Error ? error.message : String(error);
              return null;
            }
          },
        );
        this.#modelsNote =
          models && models.length > 0
            ? null
            : (reason ?? `${this.metadata.displayName} did not report its models`);
        return models && models.length > 0 ? models : null;
      });
      return;
    }
    // Profile-driven discovery: the tool lists its own models, one id per
    // line. Without such a command the list stays manual (spec §21).
    if (this.#profile.modelsArgs.length === 0 || !this.#transport) {
      return;
    }
    const transport = this.#transport;
    const args = [...this.#profile.modelsArgs];
    const command = [this.#profile.command, ...args].join(" ");
    await this.#models.refresh(async () => {
      try {
        const { stdout, exit } = await transport.exec({ args, timeoutMs: 30_000 });
        if (exit.code !== 0) {
          // The tool's own first line of complaint is more use than a code.
          const said = firstLine(exit.stderr) || firstLine(stdout);
          this.#modelsNote = said
            ? `\`${command}\` failed: ${said}`
            : `\`${command}\` failed with exit ${String(exit.code ?? "unknown")}`;
          return null;
        }
        const models = parseModelLines(stdout);
        if (models.length === 0) {
          const said = firstLine(stdout);
          this.#modelsNote = said
            ? `\`${command}\` answered with nothing that reads as a model: "${said}"`
            : `\`${command}\` answered with nothing`;
          return null;
        }
        this.#modelsNote = null;
        return models;
      } catch (error) {
        this.#modelsNote = `\`${command}\` could not be run: ${
          error instanceof Error ? error.message : String(error)
        }`;
        return null;
      }
    });
  }

  /** Profile-driven usage reading for tools with a stats command. */
  async #readUsageFromProfile(): Promise<ProviderUsageSnapshot | null> {
    const transport = this.#transport;
    if (!transport || this.#profile.usageArgs.length === 0) {
      return null;
    }
    try {
      const { stdout, exit } = await transport.exec({
        args: [...this.#profile.usageArgs],
        timeoutMs: 30_000,
      });
      if (exit.code !== 0) {
        return null;
      }
      const limits = parseOpencodeStatsUsage(stdout);
      if (!limits) {
        return null;
      }
      return {
        providerId: this.metadata.id,
        state: "available",
        limits,
        updatedAt: new Date(),
        source: "cli",
      };
    } catch {
      return null;
    }
  }

  /** Runs a hook against this entry's context; null when not initialized or on failure. */
  /** The arguments as the installed tool takes them (extension `adaptArgs`). */
  async #adaptArgs(args: string[], kind: "turn" | "interactive"): Promise<string[]> {
    if (!this.#extensions.adaptArgs) {
      return args;
    }
    const adapted = await this.#runExtension("adaptArgs", HOOK_TIMEOUT_MS.adaptArgs, (extensions, context) =>
      extensions.adaptArgs?.(args, kind, context) ?? Promise.resolve(null),
    );
    return adapted ?? args;
  }

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

      // A field the tool documents beats a pattern over its prose.
      if (auth.signedInPath) {
        const fromJson = readAuthJson(stdout, auth);
        if (fromJson) {
          return fromJson;
        }
      }

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
  if (profile.usageArgs.length > 0) {
    supported.add("usage");
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
  return (text.trim().split("\n")[0]?.trim() ?? "").slice(0, 160);
}

/**
 * Reads a sign-in state out of a probe that prints JSON, using the paths the
 * profile names. Returns null when the output is not JSON or does not carry
 * the field, so the caller falls back to its patterns rather than guessing.
 */
function readAuthJson(stdout: string, auth: CliAuth): AuthStatus | null {
  const start = stdout.indexOf("{");
  const end = stdout.lastIndexOf("}");
  if (start === -1 || end <= start) {
    return null;
  }
  let payload: unknown;
  try {
    payload = JSON.parse(stdout.slice(start, end + 1));
  } catch {
    return null;
  }

  const signedIn = readPath(payload, auth.signedInPath ?? "");
  if (typeof signedIn !== "boolean") {
    return null;
  }

  const text = (path: string | undefined): string | undefined => {
    if (!path) {
      return undefined;
    }
    const value = readPath(payload, path);
    return typeof value === "string" && value.length > 0 ? value : undefined;
  };

  if (!signedIn) {
    return {
      state: "authenticationRequired",
      method: auth.method,
      ...(auth.loginHint === undefined ? {} : { detail: auth.loginHint }),
    };
  }

  const accountLabel = text(auth.accountPath);
  const plan = text(auth.planPath);
  return {
    state: "authenticated",
    method: auth.method,
    ...(accountLabel === undefined ? {} : { accountLabel }),
    ...(plan === undefined ? {} : { plan }),
  };
}
