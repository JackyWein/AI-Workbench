import { eq } from "drizzle-orm";
import type { Database } from "@ai-workbench/database";
import { providerConfigs, type ProviderConfigRow } from "@ai-workbench/database";
import type {
  Logger,
  SaveProviderConfigInput,
  StoredProviderConfig,
} from "@ai-workbench/shared";

export interface ProviderConfigServiceOptions {
  readonly db: Database;
  readonly logger: Logger;
}

/**
 * User overrides for provider adapters (spec §15, §19): which executable to
 * run, extra arguments, the default model and adapter settings such as a
 * user-maintained model list.
 *
 * Secrets are out of scope here by design. A credential belongs in OS-backed
 * storage behind a reference (spec §57), so nothing secret is written to the
 * database or handed to the renderer.
 */
export class ProviderConfigService {
  readonly #db: Database;
  readonly #logger: Logger;

  constructor(options: ProviderConfigServiceOptions) {
    this.#db = options.db;
    this.#logger = options.logger.child("PROVIDER");
  }

  async list(): Promise<StoredProviderConfig[]> {
    const rows = await this.#db.select().from(providerConfigs);
    return rows.map(toStored);
  }

  async get(providerId: string): Promise<StoredProviderConfig | null> {
    const [row] = await this.#db
      .select()
      .from(providerConfigs)
      .where(eq(providerConfigs.providerId, providerId))
      .limit(1);
    return row ? toStored(row) : null;
  }

  async save(input: SaveProviderConfigInput): Promise<StoredProviderConfig> {
    const existing = await this.get(input.providerId);
    const now = new Date();

    const settings = { ...(existing?.settings ?? {}) };
    if (input.models !== undefined) {
      settings["models"] = input.models;
    }

    const next: StoredProviderConfig = {
      providerId: input.providerId,
      enabled: input.enabled ?? existing?.enabled ?? true,
      executablePath:
        input.executablePath === undefined
          ? (existing?.executablePath ?? null)
          : normalizePath(input.executablePath),
      arguments: input.arguments ?? existing?.arguments ?? [],
      defaultModel:
        input.defaultModel === undefined
          ? (existing?.defaultModel ?? null)
          : input.defaultModel,
      settings,
      updatedAt: now,
    };

    await this.#db
      .insert(providerConfigs)
      .values({
        providerId: next.providerId,
        enabled: next.enabled,
        executablePath: next.executablePath,
        arguments: next.arguments,
        defaultModel: next.defaultModel,
        settings: next.settings,
        createdAt: existing ? now : now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: providerConfigs.providerId,
        set: {
          enabled: next.enabled,
          executablePath: next.executablePath,
          arguments: next.arguments,
          defaultModel: next.defaultModel,
          settings: next.settings,
          updatedAt: now,
        },
      });

    this.#logger.info("Provider configuration saved", {
      providerId: next.providerId,
      hasExecutablePath: next.executablePath !== null,
    });

    return next;
  }
}

function normalizePath(value: string | null): string | null {
  const trimmed = value?.trim() ?? "";
  return trimmed.length > 0 ? trimmed : null;
}

function toStored(row: ProviderConfigRow): StoredProviderConfig {
  return {
    providerId: row.providerId,
    enabled: row.enabled,
    executablePath: row.executablePath,
    arguments: row.arguments,
    defaultModel: row.defaultModel,
    settings: row.settings,
    updatedAt: row.updatedAt,
  };
}
