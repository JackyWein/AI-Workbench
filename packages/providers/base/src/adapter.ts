import type {
  AuthStatus,
  InstallationStatus,
  ModelInfo,
  ProviderCapabilities,
  ProviderEvent,
  ProviderIntegration,
  ProviderMetadata,
  ProviderUsageSnapshot,
} from "@ai-workbench/shared";
import type {
  AgentMessage,
  AuthRequest,
  AuthResult,
  InteractiveLaunch,
  InteractiveLaunchRequest,
  ProviderContext,
  ProviderImportables,
  ProviderSessionConfig,
  ProviderSessionHandle,
  ProviderSessionInfo,
  SessionTranscript,
} from "./types.js";

/**
 * The provider-neutral contract (spec §8). Everything provider-specific lives
 * behind this interface; generic services only ever see capabilities and
 * normalized events.
 */
export interface AIProviderAdapter {
  readonly metadata: ProviderMetadata;

  initialize(context: ProviderContext): Promise<void>;
  dispose(): Promise<void>;

  detectInstallation(): Promise<InstallationStatus>;
  getAuthenticationStatus(): Promise<AuthStatus>;

  authenticate?(request?: AuthRequest): Promise<AuthResult>;
  logout?(): Promise<void>;

  getCapabilities(): Promise<ProviderCapabilities>;
  /** May answer from a cache; see `refreshModels`. */
  listModels(): Promise<ModelInfo[]>;
  /** Asks the tool again which models it offers, bypassing any cache. */
  refreshModels?(): Promise<ModelInfo[]>;
  /** When the model list was last read from the tool itself; null if never. */
  getModelsUpdatedAt?(): Date | null;

  /**
   * Why the tool's own model list is missing, when it is. A tool that was
   * asked and answered with nothing usable is not the same as one that has no
   * such command, and the user is told which.
   */
  getModelsNote?(): string | null;

  createSession(config: ProviderSessionConfig): Promise<ProviderSessionInfo>;
  resumeSession?(
    providerSessionId: string,
    config: ProviderSessionConfig,
  ): Promise<ProviderSessionInfo>;

  sendMessage(
    session: ProviderSessionHandle,
    message: AgentMessage,
  ): AsyncIterable<ProviderEvent>;

  cancel(session: ProviderSessionHandle): Promise<void>;
  destroySession(session: ProviderSessionHandle): Promise<void>;

  /**
   * The files of a conversation in this account's home, for another account
   * of the same tool to take over; null when the tool keeps none there.
   */
  exportSession?(providerSessionId: string): Promise<SessionTranscript | null>;
  /**
   * Takes over a conversation exported by another account of the same tool,
   * so it resumes here with its whole history. False when it could not.
   */
  importSession?(transcript: SessionTranscript): Promise<boolean>;

  getUsage?(): Promise<ProviderUsageSnapshot>;

  /**
   * How to start the tool's own interactive interface for a terminal agent.
   * Present only when the `interactiveTerminal` capability is.
   */
  describeInteractiveLaunch?(request: InteractiveLaunchRequest): Promise<InteractiveLaunch>;

  /** Skills and MCP servers the tool is already configured with (spec §31). */
  discoverImportables?(request: { workspacePath?: string }): Promise<ProviderImportables>;

  /**
   * How to start the tool's own sign-in for this entry's account, run in a
   * terminal so the person signs in with the tool itself (spec §14). Null when
   * the tool has no command for it.
   */
  describeLogin?(): Promise<InteractiveLaunch | null>;

  /** A one-time setup the tool needs, and whether it is done; null when none. */
  getIntegration?(): Promise<ProviderIntegration | null>;

  /**
   * The tool's own command that performs that setup, run in a terminal so the
   * person answers the tool's own questions. Null when nothing is to be done.
   */
  describeIntegrationSetup?(): Promise<InteractiveLaunch | null>;
}

/** One account of a tool, as the application hands it to a factory. */
export interface ProviderAccountRef {
  readonly id: string;
  readonly label: string;
  /** The tool's configuration home; null is the tool's own default. */
  readonly home: string | null;
}

/**
 * Creates the entries of one provider family. The application registers the
 * default entry and one per connected account without knowing anything about
 * the tool, which keeps accounts provider-independent (spec §3).
 */
export interface ProviderFactory {
  /** Id of the family; also the id of its default entry. */
  readonly family: string;
  readonly displayName: string;
  /** Present when the tool can keep separate accounts side by side. */
  readonly accounts?: {
    /** Configuration homes of further accounts that already exist here. */
    detect(): Promise<string[]>;
    /** Whether a home is the tool's default one, which is always present. */
    isDefaultHome(home: string): boolean;
  };
  create(account?: ProviderAccountRef): AIProviderAdapter;
}

export function supportsCapability(
  capabilities: ProviderCapabilities,
  capability: ProviderCapabilities["supported"][number],
): boolean {
  return capabilities.supported.includes(capability);
}
