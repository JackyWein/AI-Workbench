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

    const baseUrl =
      input.baseUrl === undefined
        ? (existing?.baseUrl ?? null)
        : normalizeBaseUrl(input.baseUrl);
    const credentialReference =
      input.credentialReference === undefined
        ? (existing?.credentialReference ?? null)
        : normalizeCredentialReference(input.credentialReference);

    // The custom-provider manifest travels inside settings, so the existing
    // overrides path forwards it to adapters without any other change. It
    // always carries `schemaVersion: 1`, so entries can be migrated later.
    if (input.baseUrl !== undefined || input.credentialReference !== undefined) {
      if (baseUrl === null && credentialReference === null) {
        delete settings["openaiCompatible"];
      } else {
        settings["openaiCompatible"] = {
          schemaVersion: 1,
          ...(baseUrl === null ? {} : { baseUrl }),
          ...(credentialReference === null ? {} : { credentialReference }),
        };
      }
    }

    const next: StoredProviderConfig = {
      providerId: input.providerId,
      enabled: input.enabled ?? existing?.enabled ?? true,
      executablePath:
        input.executablePath === undefined
          ? (existing?.executablePath ?? null)
          : normalizePath(input.executablePath),
      arguments: input.arguments ?? existing?.arguments ?? [],
      baseUrl,
      credentialReference,
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
        baseUrl: next.baseUrl,
        credentialReference: next.credentialReference,
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
          baseUrl: next.baseUrl,
          credentialReference: next.credentialReference,
          defaultModel: next.defaultModel,
          settings: next.settings,
          updatedAt: now,
        },
      });

    // Presence only: a URL is not a secret, but a reference stays opaque even
    // though it is one, so neither value is logged (spec §57, §59).
    this.#logger.info("Provider configuration saved", {
      providerId: next.providerId,
      hasExecutablePath: next.executablePath !== null,
      hasBaseUrl: next.baseUrl !== null,
      hasCredentialReference: next.credentialReference !== null,
    });

    return next;
  }
}

function normalizePath(value: string | null): string | null {
  const trimmed = value?.trim() ?? "";
  return trimmed.length > 0 ? trimmed : null;
}

/** Trims a base URL and drops trailing slashes; empty clears the value. */
function normalizeBaseUrl(value: string | null): string | null {
  const trimmed = value?.trim().replace(/\/+$/, "") ?? "";
  return trimmed.length > 0 ? trimmed : null;
}

/** Trims a credential reference; empty clears it. Never the secret itself. */
function normalizeCredentialReference(value: string | null): string | null {
  const trimmed = value?.trim() ?? "";
  return trimmed.length > 0 ? trimmed : null;
}

function toStored(row: ProviderConfigRow): StoredProviderConfig {
  return {
    providerId: row.providerId,
    enabled: row.enabled,
    executablePath: row.executablePath,
    arguments: row.arguments,
    baseUrl: row.baseUrl,
    credentialReference: row.credentialReference,
    defaultModel: row.defaultModel,
    settings: row.settings,
    updatedAt: row.updatedAt,
  };
}
