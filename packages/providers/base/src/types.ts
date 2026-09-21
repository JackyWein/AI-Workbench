import type {
  Logger,
  ModelInfo,
  ProviderCapabilities,
  ProviderConfig,
} from "@ai-workbench/shared";

/** Runtime services an adapter is given at initialization. */
export interface ProviderContext {
  readonly config: ProviderConfig;
  readonly logger: Logger;
  /** Directory the adapter may use for its own state. Already created. */
  readonly stateDirectory: string;
  /**
   * Resolves a credential reference into a secret, without the reference or the
   * secret ever reaching the renderer (spec §57).
   */
  readonly resolveCredential?: (reference: string) => Promise<string | null>;
}

export interface ProviderSessionConfig {
  /** AI Workbench session id. Not the provider-native id. */
  readonly sessionId: string;
  readonly workingDirectory: string;
  readonly modelId?: string;
  /** Effective, already-resolved skill instructions (spec §30). */
  readonly systemInstructions?: string;
  readonly settings?: Record<string, unknown>;
}

export interface ProviderSessionInfo {
  /** Provider-native id, persisted when the provider supports resume. */
  readonly providerSessionId: string;
  readonly resumable: boolean;
  readonly modelId?: string;
}

export interface ProviderSessionHandle {
  readonly sessionId: string;
  readonly providerSessionId: string;
  readonly modelId?: string;
}

export interface AgentMessage {
  readonly text: string;
  readonly attachments?: ReadonlyArray<{
    readonly kind: "file" | "image";
    readonly path: string;
  }>;
}

export interface AuthRequest {
  readonly method: "cli" | "oauth" | "apiKey" | "custom";
  readonly apiKeyReference?: string;
}

export interface AuthResult {
  readonly ok: boolean;
  readonly detail?: string;
}

export interface ProviderModelList {
  readonly models: ModelInfo[];
  readonly defaultModelId?: string;
}

export type { ProviderCapabilities };
