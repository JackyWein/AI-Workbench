import type {
  AuthStatus,
  InstallationStatus,
  ModelInfo,
  ProviderCapabilities,
  ProviderEvent,
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

  getUsage?(): Promise<ProviderUsageSnapshot>;

  /**
   * How to start the tool's own interactive interface for a terminal agent.
   * Present only when the `interactiveTerminal` capability is.
   */
  describeInteractiveLaunch?(request: InteractiveLaunchRequest): Promise<InteractiveLaunch>;

  /** Skills and MCP servers the tool is already configured with (spec §31). */
  discoverImportables?(request: { workspacePath?: string }): Promise<ProviderImportables>;
}

export function supportsCapability(
  capabilities: ProviderCapabilities,
  capability: ProviderCapabilities["supported"][number],
): boolean {
  return capabilities.supported.includes(capability);
}
