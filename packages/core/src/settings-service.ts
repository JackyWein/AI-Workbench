import { eq } from "drizzle-orm";
import type { Database } from "@ai-workbench/database";
import { settings } from "@ai-workbench/database";
import {
  appSettingsSchema,
  defaultAppSettings,
  type AppSettings,
  type Logger,
  type UpdateSettingsInput,
  upgradeStoredSettings,
} from "@ai-workbench/shared";

const SETTINGS_KEY = "app";

export interface SettingsServiceOptions {
  readonly db: Database;
  readonly logger: Logger;
}

/**
 * Application settings, stored as one validated document. Unknown or corrupted
 * stored values fall back to defaults instead of breaking startup (spec §60).
 */
export class SettingsService {
  readonly #db: Database;
  readonly #logger: Logger;

  constructor(options: SettingsServiceOptions) {
    this.#db = options.db;
    this.#logger = options.logger.child("CORE");
  }

  async get(): Promise<AppSettings> {
    const [row] = await this.#db
      .select()
      .from(settings)
      .where(eq(settings.key, SETTINGS_KEY))
      .limit(1);

    if (!row) {
      return defaultAppSettings;
    }

    const parsed = appSettingsSchema.safeParse(upgradeStoredSettings(row.value));
    if (!parsed.success) {
      this.#logger.warn("Stored settings were invalid; using defaults");
      return defaultAppSettings;
    }
    return parsed.data;
  }

  async update(input: UpdateSettingsInput): Promise<AppSettings> {
    const current = await this.get();
    const next = appSettingsSchema.parse({ ...current, ...input });

    await this.#db
      .insert(settings)
      .values({ key: SETTINGS_KEY, value: next, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: settings.key,
        set: { value: next, updatedAt: new Date() },
      });

    return next;
  }
}
