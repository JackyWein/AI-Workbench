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
  /** Last configuration applied per provider, so it can be re-applied. */
  readonly #configs = new Map<string, Partial<ProviderConfig>>();

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
    this.#configs.set(adapter.metadata.id, config ?? {});
    await this.#initialize(adapter);
  }

  /**
   * Applies changed configuration to a registered adapter by disposing and
   * initializing it again, so a new executable path or argument list takes
   * effect without restarting the application.
   */
  async reconfigure(
    providerId: string,
    config: Partial<ProviderConfig>,
  ): Promise<void> {
    const adapter = this.registry.require(providerId);
    this.#configs.set(providerId, config);

    try {
      await adapter.dispose();
    } catch (error) {
      this.#logger.warn("Provider disposal during reconfigure failed", {
        providerId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    this.#initialized.delete(providerId);
    await this.#initialize(adapter);
  }

  async #initialize(adapter: AIProviderAdapter): Promise<void> {
    const stateDirectory = join(this.#options.stateDirectory, adapter.metadata.id);
    await mkdir(stateDirectory, { recursive: true });

    const context: ProviderContext = {
      config: buildConfig(adapter, this.#configs.get(adapter.metadata.id)),
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
      // A provider that cannot initialize is reported as unavailable rather
      // than breaking startup (spec §18, §60).
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

  async describe(providerId: string): Promise<ProviderSummary> {
    return this.registry.describe(this.registry.require(providerId));
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
