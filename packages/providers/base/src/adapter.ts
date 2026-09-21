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
  ProviderContext,
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
  listModels(): Promise<ModelInfo[]>;

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
}

export function supportsCapability(
  capabilities: ProviderCapabilities,
  capability: ProviderCapabilities["supported"][number],
): boolean {
  return capabilities.supported.includes(capability);
}
