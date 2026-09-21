import type {
  Logger,
  ModelInfo,
  PermissionMode,
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
  /**
   * Tells the application the adapter learned something new on its own — a
   * model list, usage or sign-in state read in the background — so the UI can
   * refresh without polling.
   */
  readonly notifyChanged?: () => void;
}

/**
 * What tools a session may use, described structurally so the provider layer
 * does not depend on the MCP package (spec §36).
 */
export interface ProviderToolAccess {
  readonly kind: "provider-mcp" | "host-mediated" | "none";
  /** Servers the provider is expected to connect to itself. */
  readonly mcpServers: ReadonlyArray<{
    readonly id: string;
    readonly name: string;
    readonly transport: string;
    readonly command?: string;
    readonly args?: readonly string[];
    readonly env?: Readonly<Record<string, string>>;
    readonly url?: string;
    readonly cwd?: string;
  }>;
  /** Tools the application executes on the provider's behalf. */
  readonly hostTools: ReadonlyArray<{
    readonly serverId: string;
    readonly name: string;
    readonly description: string;
    readonly inputSchema: Readonly<Record<string, unknown>>;
  }>;
}

export interface ProviderSessionConfig {
  /** AI Workbench session id. Not the provider-native id. */
  readonly sessionId: string;
  readonly workingDirectory: string;
  readonly modelId?: string;
  /** Effective, already-resolved skill instructions (spec §30). */
  readonly systemInstructions?: string;
  /** Resolved by the tool bridge before the session is created. */
  readonly toolAccess?: ProviderToolAccess;
  /** A reasoning effort the model reported it accepts. */
  readonly reasoningEffort?: string;
  /** Mapped by the adapter onto the tool's own permission system (spec §54). */
  readonly permissionMode?: PermissionMode;
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
  readonly reasoningEffort?: string;
  readonly permissionMode?: PermissionMode;
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

/** Starting the provider's own interactive interface in a terminal. */
export interface InteractiveLaunchRequest {
  readonly workingDirectory: string;
  readonly modelId?: string;
  readonly reasoningEffort?: string;
  readonly permissionMode?: PermissionMode;
  readonly systemInstructions?: string;
  readonly toolAccess?: ProviderToolAccess;
}

export interface InteractiveLaunch {
  /** Absolute path of the executable. */
  readonly command: string;
  readonly args: string[];
  /** Merged over the application's environment by whoever starts it. */
  readonly env: Record<string, string>;
  readonly cwd: string;
}

/** A skill the tool's own configuration already has (spec §31). */
export interface ImportableSkill {
  /** Directory that holds the skill's SKILL.md. */
  readonly path: string;
  readonly name: string;
  readonly description: string;
  /** Where it was found, e.g. "user skills" or "plugin fallow". */
  readonly source: string;
}

/**
 * An MCP server the tool is configured with. Values of `env` and `headers`
 * may be secrets: they stay in the main process and are moved into secure
 * storage when imported, never shown or stored in plain text.
 */
export interface ImportableMcpServer {
  readonly name: string;
  readonly source: string;
  readonly transport: "stdio" | "http" | "sse";
  readonly command?: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  readonly url?: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly cwd?: string;
}

export interface ProviderImportables {
  readonly skills: readonly ImportableSkill[];
  readonly mcpServers: readonly ImportableMcpServer[];
}

export type { ProviderCapabilities };
