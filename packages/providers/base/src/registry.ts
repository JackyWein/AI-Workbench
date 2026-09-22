import type { Logger, ProviderSummary } from "@ai-workbench/shared";
import type { AIProviderAdapter } from "./adapter.js";

export interface ProviderRegistryOptions {
  readonly logger: Logger;
}

/**
 * Holds the adapters the application knows about (spec §17). Registration is
 * data-driven so an external package can be added without core edits: whoever
 * loads the package calls `register`, and nothing here knows provider brands.
 *
 * A failing or missing provider must never break the app (spec §18), so every
 * adapter call made on behalf of the UI is isolated here.
 */
export class ProviderRegistry {
  readonly #adapters = new Map<string, AIProviderAdapter>();
  readonly #logger: Logger;

  constructor(options: ProviderRegistryOptions) {
    this.#logger = options.logger;
  }

  register(adapter: AIProviderAdapter): void {
    const id = adapter.metadata.id;
    if (this.#adapters.has(id)) {
      throw new Error(`Provider "${id}" is already registered`);
    }
    this.#adapters.set(id, adapter);
    this.#logger.info("Provider registered", {
      providerId: id,
      adapterVersion: adapter.metadata.adapterVersion,
    });
  }

  unregister(id: string): boolean {
    const removed = this.#adapters.delete(id);
    if (removed) {
      this.#logger.info("Provider unregistered", { providerId: id });
    }
    return removed;
  }

  get(id: string): AIProviderAdapter | undefined {
    return this.#adapters.get(id);
  }

  require(id: string): AIProviderAdapter {
    const adapter = this.#adapters.get(id);
    if (!adapter) {
      throw new Error(`Provider "${id}" is not registered`);
    }
    return adapter;
  }

  list(): AIProviderAdapter[] {
    return [...this.#adapters.values()];
  }

  has(id: string): boolean {
    return this.#adapters.has(id);
  }

  /** Adapters that are installed and usable right now. */
  async getAvailable(): Promise<AIProviderAdapter[]> {
    const checks = await Promise.all(
      this.list().map(async (adapter) => {
        const installation = await this.#safe(adapter, "detectInstallation", () =>
          adapter.detectInstallation(),
        );
        return installation?.state === "installed" ? adapter : null;
      }),
    );
    return checks.filter((adapter): adapter is AIProviderAdapter => adapter !== null);
  }

  /**
   * Builds the payload the renderer needs. A provider that throws is reported
   * with an unknown state instead of taking the list down with it.
   */
  async describeAll(): Promise<ProviderSummary[]> {
    return Promise.all(this.list().map((adapter) => this.describe(adapter)));
  }

  async describe(adapter: AIProviderAdapter): Promise<ProviderSummary> {
    const [installation, auth, capabilities, models, usage] = await Promise.all([
      this.#safe(adapter, "detectInstallation", () => adapter.detectInstallation()),
      this.#safe(adapter, "getAuthenticationStatus", () =>
        adapter.getAuthenticationStatus(),
      ),
      this.#safe(adapter, "getCapabilities", () => adapter.getCapabilities()),
      this.#safe(adapter, "listModels", () => adapter.listModels()),
      adapter.getUsage
        ? this.#safe(adapter, "getUsage", () => adapter.getUsage!())
        : Promise.resolve(null),
    ]);

    return {
      metadata: adapter.metadata,
      installation: installation ?? {
        state: "unknown",
        detail: "Installation check failed",
      },
      auth: auth ?? { state: "unknown", detail: "Authentication check failed" },
      capabilities: capabilities ?? { supported: [] },
      models: models ?? [],
      modelsUpdatedAt: this.#modelsUpdatedAt(adapter),
      modelsNote: this.#modelsNote(adapter),
      usage: usage ?? null,
      // The manager overlays the user's choice; unknown to the registry means on.
      enabled: true,
    };
  }

  #modelsUpdatedAt(adapter: AIProviderAdapter): Date | null {
    try {
      return adapter.getModelsUpdatedAt?.() ?? null;
    } catch {
      return null;
    }
  }

  #modelsNote(adapter: AIProviderAdapter): string | null {
    try {
      return adapter.getModelsNote?.() ?? null;
    } catch {
      return null;
    }
  }

  async #safe<T>(
    adapter: AIProviderAdapter,
    operation: string,
    run: () => Promise<T>,
  ): Promise<T | null> {
    try {
      return await run();
    } catch (error) {
      this.#logger.warn("Provider call failed", {
        providerId: adapter.metadata.id,
        operation,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }
}
