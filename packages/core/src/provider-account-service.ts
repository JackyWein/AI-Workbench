import { mkdir } from "node:fs/promises";
import { basename, isAbsolute, join, resolve } from "node:path";
import { eq } from "drizzle-orm";
import type { Database } from "@ai-workbench/database";
import { providerAccounts, type ProviderAccountRow } from "@ai-workbench/database";
import {
  accountProviderId,
  type AddProviderAccountInput,
  type DetectedProviderAccount,
  type Logger,
  type ProviderAccount,
  type ProviderConfig,
} from "@ai-workbench/shared";
import type { EventBus } from "./event-bus.js";
import { normalizeHome, type ProviderManager } from "./provider-manager.js";

export interface ProviderAccountServiceOptions {
  readonly db: Database;
  readonly events: EventBus;
  readonly logger: Logger;
  readonly providers: ProviderManager;
  /** Where homes the application creates for new accounts live. */
  readonly accountsDirectory: string;
  /** Stored configuration for a provider entry, applied when it registers. */
  readonly configFor?: (providerId: string) => Partial<ProviderConfig>;
}

/**
 * Further accounts of tools that keep several side by side (spec §39).
 *
 * An account is a configuration home; the tool keeps its own sign-in,
 * settings and history there. The application only remembers which homes the
 * person connected and gives each one a provider entry. It never reads the
 * tool's credentials — signing in happens in the tool itself.
 */
export class ProviderAccountService {
  readonly #db: Database;
  readonly #events: EventBus;
  readonly #logger: Logger;
  readonly #providers: ProviderManager;
  readonly #accountsDirectory: string;
  readonly #configFor: (providerId: string) => Partial<ProviderConfig>;

  constructor(options: ProviderAccountServiceOptions) {
    this.#db = options.db;
    this.#events = options.events;
    this.#logger = options.logger.child("PROVIDER");
    this.#providers = options.providers;
    this.#accountsDirectory = options.accountsDirectory;
    this.#configFor = options.configFor ?? (() => ({}));
  }

  async list(): Promise<ProviderAccount[]> {
    const rows = await this.#db.select().from(providerAccounts);
    return rows.map(toAccount).sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  }

  /** Registers a provider entry for every stored account; used at startup. */
  async restore(): Promise<void> {
    for (const account of await this.list()) {
      try {
        await this.#providers.addAccount(
          account.family,
          { id: account.id, label: account.label, home: account.home },
          this.#configFor(accountProviderId(account.family, account.id)),
        );
      } catch (error) {
        // A family that is no longer installed must not stop the others.
        this.#logger.warn("Stored account could not be restored", {
          accountId: account.id,
          family: account.family,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  async add(input: AddProviderAccountInput): Promise<ProviderAccount> {
    const factory = this.#providers.factories().find((entry) => entry.family === input.family);
    if (!factory?.accounts) {
      throw new Error(`"${input.family}" does not support separate accounts`);
    }

    const existing = await this.list();
    const id = uniqueId(slug(input.label), new Set(existing.map((account) => account.id)));

    let home: string;
    if (input.home) {
      if (!isAbsolute(input.home)) {
        throw new Error("An account home must be an absolute path");
      }
      home = resolve(input.home);
      if (factory.accounts.isDefaultHome(home)) {
        throw new Error("This is the tool's default account, which is always connected");
      }
    } else {
      // A fresh, empty home the person signs into with the tool itself.
      home = join(this.#accountsDirectory, input.family, id);
      await mkdir(home, { recursive: true });
    }

    const normalized = normalizeHome(home);
    if (existing.some((account) => account.family === input.family && normalizeHome(account.home) === normalized)) {
      throw new Error("This account is already connected");
    }

    const account: ProviderAccount = {
      id,
      family: input.family,
      label: input.label.trim(),
      home,
      createdAt: new Date(),
    };
    await this.#db.insert(providerAccounts).values(account);
    await this.#providers.addAccount(
      account.family,
      { id: account.id, label: account.label, home: account.home },
      this.#configFor(accountProviderId(account.family, account.id)),
    );

    this.#logger.info("Account connected", { accountId: id, family: input.family });
    this.#events.publish({ type: "provider.list.changed" });
    return account;
  }

  /** Disconnects an account. Its home and whatever the tool keeps there stay. */
  async remove(id: string): Promise<boolean> {
    const [row] = await this.#db
      .select()
      .from(providerAccounts)
      .where(eq(providerAccounts.id, id))
      .limit(1);
    if (!row) {
      return false;
    }
    await this.#db.delete(providerAccounts).where(eq(providerAccounts.id, id));
    await this.#providers.removeAccount(accountProviderId(row.family, row.id));
    this.#logger.info("Account disconnected", { accountId: id, family: row.family });
    this.#events.publish({ type: "provider.list.changed" });
    return true;
  }

  /** Homes on this machine that look like accounts and are not connected. */
  async detect(): Promise<DetectedProviderAccount[]> {
    const known = new Set((await this.list()).map((account) => normalizeHome(account.home)));
    const candidates = await this.#providers.detectAccounts(known);
    return candidates.map((candidate) => ({
      family: candidate.family,
      toolName: candidate.toolName,
      home: candidate.home,
      suggestedLabel: labelFromHome(candidate.home),
    }));
  }
}

function toAccount(row: ProviderAccountRow): ProviderAccount {
  return {
    id: row.id,
    family: row.family,
    label: row.label,
    home: row.home,
    createdAt: row.createdAt,
  };
}

function slug(label: string): string {
  const value = label
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return value.length > 0 ? value : "account";
}

function uniqueId(base: string, taken: ReadonlySet<string>): string {
  if (!taken.has(base)) {
    return base;
  }
  for (let index = 2; ; index += 1) {
    const candidate = `${base}-${index}`;
    if (!taken.has(candidate)) {
      return candidate;
    }
  }
}

/** "~/.tool-work" becomes "work"; anything else keeps its folder name. */
function labelFromHome(home: string): string {
  const name = basename(home.replace(/[\\/]+$/, ""));
  const suffix = /^\.?[a-z0-9]+-(.+)$/i.exec(name)?.[1];
  const label = suffix ?? name.replace(/^\./, "");
  return label.length > 0 ? `Account ${label}` : "Account";
}
