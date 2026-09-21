import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import {
  ProviderRegistry,
  type AIProviderAdapter,
  type ProviderContext,
} from "@ai-workbench/provider-base";
import type {
  Logger,
  ProviderConfig,
  ProviderSummary,
} from "@ai-workbench/shared";

export interface ProviderManagerOptions {
  readonly logger: Logger;
  /** Root directory where each adapter gets its own state folder. */
  readonly stateDirectory: string;
  readonly resolveCredential?: (reference: string) => Promise<string | null>;
}

/**
 * Owns adapter lifecycle. It never branches on a provider id: configuration
 * comes from the adapter's own metadata or from stored configuration, so a new
 * provider package only has to be registered (spec §3, §17).
 */
export class ProviderManager {
  readonly registry: ProviderRegistry;
  readonly #logger: Logger;
  readonly #options: ProviderManagerOptions;
  readonly #initialized = new Set<string>();

  constructor(options: ProviderManagerOptions) {
    this.#options = options;
    this.#logger = options.logger.child("PROVIDER");
    this.registry = new ProviderRegistry({ logger: this.#logger });
  }

  /**
   * Registers and initializes an adapter. Initialization failure is contained:
   * the adapter stays registered and is reported as unavailable rather than
   * taking down startup (spec §18, §60).
   */
  async register(
    adapter: AIProviderAdapter,
    config?: Partial<ProviderConfig>,
  ): Promise<void> {
    this.registry.register(adapter);

    const stateDirectory = join(
      this.#options.stateDirectory,
      adapter.metadata.id,
    );
    await mkdir(stateDirectory, { recursive: true });

    const context: ProviderContext = {
      config: buildConfig(adapter, config),
      logger: this.#logger.child("PROVIDER"),
      stateDirectory,
      ...(this.#options.resolveCredential
        ? { resolveCredential: this.#options.resolveCredential }
        : {}),
    };

    try {
      await adapter.initialize(context);
      this.#initialized.add(adapter.metadata.id);
    } catch (error) {
      this.#logger.error("Provider initialization failed", {
        providerId: adapter.metadata.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  get(providerId: string): AIProviderAdapter | undefined {
    return this.registry.get(providerId);
  }

  isInitialized(providerId: string): boolean {
    return this.#initialized.has(providerId);
  }

  async describeAll(): Promise<ProviderSummary[]> {
    return this.registry.describeAll();
  }

  /** First registered provider, used when a session has no explicit choice. */
  defaultProviderId(): string | null {
    return this.registry.list()[0]?.metadata.id ?? null;
  }

  async dispose(): Promise<void> {
    for (const adapter of this.registry.list()) {
      try {
        await adapter.dispose();
      } catch (error) {
        this.#logger.warn("Provider disposal failed", {
          providerId: adapter.metadata.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    this.#initialized.clear();
  }
}

function buildConfig(
  adapter: AIProviderAdapter,
  overrides: Partial<ProviderConfig> | undefined,
): ProviderConfig {
  return {
    id: adapter.metadata.id,
    adapterId: adapter.metadata.id,
    transport: adapter.metadata.transportTypes[0] ?? "custom",
    authType: adapter.metadata.authMethods[0] ?? "none",
    ...overrides,
  };
}
