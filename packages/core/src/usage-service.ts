import type {
  AggregatedUsage,
  Logger,
  ProviderUsageSnapshot,
} from "@ai-workbench/shared";
import type { EventBus } from "./event-bus.js";
import type { ProviderManager } from "./provider-manager.js";

export interface UsageServiceOptions {
  readonly providers: ProviderManager;
  readonly events: EventBus;
  readonly logger: Logger;
  /** Cache lifetime; providers must not be polled aggressively (spec §108). */
  readonly ttlMs?: number;
}

/**
 * Aggregates usage across providers for the compact indicator and its popover
 * (spec §65). A provider that cannot report usage is reported as unavailable —
 * numbers are never invented (spec §56).
 */
export class UsageService {
  readonly #providers: ProviderManager;
  readonly #events: EventBus;
  readonly #logger: Logger;
  readonly #ttlMs: number;

  #cache: AggregatedUsage | null = null;
  #fetchedAt = 0;
  #inFlight: Promise<AggregatedUsage> | null = null;

  constructor(options: UsageServiceOptions) {
    this.#providers = options.providers;
    this.#events = options.events;
    this.#logger = options.logger.child("PROVIDER");
    this.#ttlMs = options.ttlMs ?? 60_000;
  }

  async get(): Promise<AggregatedUsage> {
    if (this.#cache && Date.now() - this.#fetchedAt < this.#ttlMs) {
      return this.#cache;
    }
    return this.refresh();
  }

  async refresh(): Promise<AggregatedUsage> {
    this.#inFlight ??= this.#collect().finally(() => {
      this.#inFlight = null;
    });
    return this.#inFlight;
  }

  async #collect(): Promise<AggregatedUsage> {
    const adapters = this.#providers.registry.list();
    const snapshots = await Promise.all(
      adapters.map(async (adapter): Promise<ProviderUsageSnapshot> => {
        const providerId = adapter.metadata.id;
        if (!adapter.getUsage) {
          return unavailable(providerId, "This provider does not report usage");
        }
        try {
          return await adapter.getUsage();
        } catch (error) {
          this.#logger.warn("Usage lookup failed", {
            providerId,
            error: error instanceof Error ? error.message : String(error),
          });
          return unavailable(providerId, "Usage could not be read");
        }
      }),
    );

    const usage: AggregatedUsage = { snapshots, updatedAt: new Date() };
    this.#cache = usage;
    this.#fetchedAt = Date.now();
    this.#events.publish({ type: "provider.usage.updated", usage });
    return usage;
  }

  invalidate(): void {
    this.#fetchedAt = 0;
  }

  /** The last collected usage, however old, without asking any tool. */
  latest(): AggregatedUsage | null {
    return this.#cache;
  }
}

function unavailable(providerId: string, note: string): ProviderUsageSnapshot {
  return {
    providerId,
    state: "unavailable",
    limits: [],
    updatedAt: new Date(),
    source: "provider",
    note,
  };
}
