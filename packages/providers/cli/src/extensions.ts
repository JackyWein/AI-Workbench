import type {
  AuthStatus,
  Logger,
  ModelInfo,
  ProviderEvent,
  ProviderIntegration,
  ProviderUsageSnapshot,
  TerminalActivity,
  TerminalAttention,
  TerminalAttentionResponse,
  TerminalMetrics,
} from "@ai-workbench/shared";
import type {
  ProviderImportables,
  ProviderToolAccess,
  TerminalKeys,
} from "@ai-workbench/provider-base";
import type { CliExit, CliRun } from "@ai-workbench/transport-cli";
import type { CliProviderProfile } from "./profile.js";

/**
 * What an extension may use. Everything runs through the same transport as a
 * turn — same executable, same account environment, no shell — so a probe can
 * never reach a different tool or account than the one it describes.
 */
export interface CliExtensionContext {
  readonly profile: CliProviderProfile;
  /** Id of this provider entry, which differs from the profile id per account. */
  readonly providerId: string;
  readonly logger: Logger;
  /** Directory this entry may keep its own state in. Already created. */
  readonly stateDirectory: string;
  /**
   * The environment this entry runs the tool with: the profile's variables,
   * the account's configuration home and anything the user configured.
   */
  readonly env: Readonly<Record<string, string>>;
  /** The configuration home of this entry's account, when the tool has accounts. */
  readonly accountHome: string | null;
  /** The executable, or null when the tool is not installed. */
  locate(): Promise<string | null>;
  /**
   * The installed version as the application's detection read it, or null.
   * Reuses that reading: starting the tool again only to ask costs a process
   * and can collide with a run starting at the same moment.
   */
  version(): Promise<string | null>;
  /** Runs the tool to completion and buffers its output. For probes. */
  exec(
    args: string[],
    options?: { readonly timeoutMs?: number; readonly stdin?: string; readonly cwd?: string },
  ): Promise<{ stdout: string; exit: CliExit }>;
  /** Starts the tool and streams its output, for longer conversations. */
  start(
    args: string[],
    options?: { readonly timeoutMs?: number; readonly stdin?: string; readonly cwd?: string },
  ): Promise<CliRun>;
}

/** One interactive run of the tool, as telemetry needs to find it. */
export interface CliInteractiveRun {
  /** Unique per run; safe to use in file names. */
  readonly runId: string;
  readonly workingDirectory: string;
  readonly startedAt: Date;
}

/**
 * How an extension follows one interactive run (spec §55): arguments and
 * variables that make the tool report on itself, and a watcher that turns
 * those reports into metrics.
 */
export interface CliInteractiveTelemetry {
  /** Added to the tool's arguments for this run. */
  readonly args?: readonly string[];
  /** Added to the tool's environment for this run. */
  readonly env?: Readonly<Record<string, string>>;
  /** Where the numbers come from, e.g. "Codex session log". */
  readonly source: string;
  /** Starts watching; the returned function stops it. Must not throw. */
  watch(onMetrics: (metrics: TerminalMetrics) => void): () => void;
  /** Follows what the tool waits on the person for; null once nothing waits. */
  watchAttention?(onAttention: (attention: TerminalAttention | null) => void): () => void;
  /** Follows whether the tool works on a turn or idles at its prompt. */
  watchActivity?(onActivity: (activity: TerminalActivity | null) => void): () => void;
  /** Answers the waiting request from outside the terminal; false when it cannot. */
  respond?(
    attentionId: string,
    response: TerminalAttentionResponse,
    terminal: TerminalKeys,
  ): Promise<boolean>;
}

/** Per-turn memory for a custom line parser, e.g. to pair tool calls. */
export interface CliParseState {
  readonly values: Map<string, unknown>;
}

/**
 * Provider-specific knowledge that cannot be expressed as profile data: talking
 * to a tool's own protocol to ask for its models, reading its limits, parsing a
 * richer event stream. Extensions live in the provider's own package (spec
 * §3); the generic adapter only calls these hooks and never names a provider.
 *
 * Every hook may return null — "the tool could not say" — and the adapter then
 * falls back to what the profile knows, never to a guess.
 */
export interface CliProviderExtensions {
  /** The models this account may use, as the tool reports them. */
  discoverModels?(context: CliExtensionContext): Promise<ModelInfo[] | null>;
  /** Account limits, read without spending a turn. */
  readUsage?(context: CliExtensionContext): Promise<ProviderUsageSnapshot | null>;
  /**
   * Follows an interactive run: session time, tokens, cost, context and the
   * account limits the tool reports while it runs.
   */
  interactiveTelemetry?(
    context: CliExtensionContext,
    run: CliInteractiveRun,
  ): Promise<CliInteractiveTelemetry | null>;
  /** Whether and as whom the tool is signed in, without prompting anyone. */
  probeAuth?(context: CliExtensionContext): Promise<AuthStatus | null>;
  /** Skills and MCP servers in the tool's own configuration (spec §31). */
  discoverImportables?(
    context: CliExtensionContext,
    request: { readonly workspacePath?: string },
  ): Promise<ProviderImportables>;
  /**
   * Arguments and environment that hand the given MCP servers to the tool, for
   * a tool whose configuration format none of the profile's strategies write
   * (profile `mcp.via: "extension"`).
   */
  mcpLaunch?(
    servers: ProviderToolAccess["mcpServers"],
    context: CliExtensionContext,
    combined?: ProviderToolAccess["combined"],
  ): { readonly args: string[]; readonly env: Record<string, string> };
  /**
   * A one-time setup the tool needs for what cannot be given per run, such as
   * an extension installed with the tool's own installer. `setupArgs` are the
   * tool's own arguments for it, run in a terminal so the person answers the
   * tool's questions; null when nothing is to be done.
   */
  integration?: {
    status(context: CliExtensionContext): Promise<ProviderIntegration | null>;
    setupArgs(context: CliExtensionContext): Promise<string[] | null>;
  };
  /**
   * Adjusts the arguments of a headless turn or of an interactive run just
   * before the tool starts, for a tool whose command line differs between
   * its releases. Returning null keeps the arguments as built.
   */
  adaptArgs?(
    args: readonly string[],
    kind: "turn" | "interactive",
    context: CliExtensionContext,
  ): Promise<string[] | null>;
  /**
   * Decodes one line of turn output. Returning undefined hands the line to the
   * profile's rules instead, so an extension only has to cover what the rules
   * cannot, such as tool calls spread over several events.
   */
  parseLine?(line: string, state: CliParseState): ProviderEvent[] | undefined;
}
