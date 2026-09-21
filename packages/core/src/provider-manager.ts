import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import {
  ProviderRegistry,
  type AIProviderAdapter,
  type ProviderAccountRef,
  type ProviderContext,
  type ProviderFactory,
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
  /**
   * Called with a fresh summary when a provider learned something on its own,
   * such as its model list or limits read in the background.
   */
  readonly onProviderChanged?: (summary: ProviderSummary) => void;
}

/** A configuration home of a tool that could become another account. */
export interface AccountCandidate {
  readonly family: string;
  readonly toolName: string;
  readonly home: string;
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
  readonly #factories = new Map<string, ProviderFactory>();
  readonly #pendingUpdates = new Map<string, NodeJS.Timeout>();

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
   * Registers a provider family: its default entry now, and one entry per
   * account later through `addAccount`. The manager never learns what the
   * tool is; the factory knows how to make its entries.
   */
  async registerFactory(
    factory: ProviderFactory,
    config?: Partial<ProviderConfig>,
  ): Promise<void> {
    this.#factories.set(factory.family, factory);
    await this.register(factory.create(), config);
  }

  factories(): ProviderFactory[] {
    return [...this.#factories.values()];
  }

  /** Registers the entry of one more account of a family. */
  async addAccount(
    family: string,
    account: ProviderAccountRef,
    config?: Partial<ProviderConfig>,
  ): Promise<AIProviderAdapter> {
    const factory = this.#factories.get(family);
    if (!factory?.accounts) {
      throw new Error(`"${family}" does not support separate accounts`);
    }
    const adapter = factory.create(account);
    if (this.registry.has(adapter.metadata.id)) {
      return this.registry.require(adapter.metadata.id);
    }
    await this.register(adapter, config);
    return adapter;
  }

  /** Removes an account entry; the account's files are left untouched. */
  async removeAccount(providerId: string): Promise<boolean> {
    const adapter = this.registry.get(providerId);
    if (!adapter?.metadata.account) {
      return false;
    }
    try {
      await adapter.dispose();
    } catch (error) {
      this.#logger.warn("Provider disposal failed", {
        providerId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    this.#initialized.delete(providerId);
    this.#configs.delete(providerId);
    return this.registry.unregister(providerId);
  }

  /**
   * Existing configuration homes of every family that supports accounts,
   * leaving out each tool's default home and anything listed in `known`.
   */
  async detectAccounts(known: ReadonlySet<string>): Promise<AccountCandidate[]> {
    const candidates: AccountCandidate[] = [];
    for (const factory of this.#factories.values()) {
      if (!factory.accounts) {
        continue;
      }
      let homes: string[] = [];
      try {
        homes = await factory.accounts.detect();
      } catch (error) {
        this.#logger.warn("Account detection failed", {
          family: factory.family,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      for (const home of homes) {
        if (factory.accounts.isDefaultHome(home) || known.has(normalizeHome(home))) {
          continue;
        }
        candidates.push({ family: factory.family, toolName: factory.displayName, home });
      }
    }
    return candidates;
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

  /**
   * Coalesces bursts of background discoveries into one update per provider,
   * so a tool reporting models, sign-in and limits at once refreshes the UI
   * once rather than three times.
   */
  #scheduleUpdate(providerId: string): void {
    if (!this.#options.onProviderChanged || this.#pendingUpdates.has(providerId)) {
      return;
    }
    const timer = setTimeout(() => {
      this.#pendingUpdates.delete(providerId);
      const adapter = this.registry.get(providerId);
      if (!adapter) {
        return;
      }
      void this.registry
        .describe(adapter)
        .then((summary) => this.#options.onProviderChanged?.(summary))
        .catch((error: unknown) =>
          this.#logger.warn("Provider update could not be described", {
            providerId,
            error: error instanceof Error ? error.message : String(error),
          }),
        );
    }, 250);
    timer.unref?.();
    this.#pendingUpdates.set(providerId, timer);
  }

  /**
   * Starts a provider over with its current configuration, dropping whatever
   * it cached — used after the person signed in with the tool itself.
   */
  async reinitialize(providerId: string): Promise<void> {
    await this.reconfigure(providerId, this.#configs.get(providerId) ?? {});
    this.#scheduleUpdate(providerId);
  }

  async #initialize(adapter: AIProviderAdapter): Promise<void> {
    // Account ids contain characters that are awkward in folder names.
    const stateDirectory = join(
      this.#options.stateDirectory,
      adapter.metadata.id.replace(/[^A-Za-z0-9._-]/g, "_"),
    );
    await mkdir(stateDirectory, { recursive: true });

    const context: ProviderContext = {
      config: buildConfig(adapter, this.#configs.get(adapter.metadata.id)),
      logger: this.#logger.child("PROVIDER"),
      stateDirectory,
      ...(this.#options.resolveCredential
        ? { resolveCredential: this.#options.resolveCredential }
        : {}),
      notifyChanged: () => this.#scheduleUpdate(adapter.metadata.id),
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
    for (const timer of this.#pendingUpdates.values()) {
      clearTimeout(timer);
    }
    this.#pendingUpdates.clear();
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

/** Compares configuration homes the way the file system does. */
export function normalizeHome(home: string): string {
  const trimmed = home.replace(/[\\/]+$/, "");
  return process.platform === "win32"
    ? trimmed.replace(/\//g, "\\").toLowerCase()
    : trimmed;
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
