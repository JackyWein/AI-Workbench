import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import type { Database } from "@ai-workbench/database";
import {
  pluginAccounts,
  plugins,
  sessionPlugins,
  workspacePlugins,
  type PluginAccountRow,
  type PluginRow,
} from "@ai-workbench/database";
import { PluginRegistry } from "@ai-workbench/plugins";
import type {
  Logger,
  PluginAccount,
  PluginAssignmentInput,
  PluginManifest,
  PluginManifestInput,
  ResolvedPlugin,
} from "@ai-workbench/shared";
import type { CredentialManager } from "@ai-workbench/credentials";

export interface PluginServiceOptions {
  readonly db: Database;
  readonly logger: Logger;
  readonly credentials: CredentialManager;
}

/**
 * Persists plugins, their scope assignments and the accounts that serve them
 * (spec §33–§35). Secrets never pass through here: an account holds a
 * credential reference and the CredentialManager owns the value.
 */
export class PluginService {
  readonly #db: Database;
  readonly #logger: Logger;
  readonly #credentials: CredentialManager;
  readonly #registry: PluginRegistry;

  constructor(options: PluginServiceOptions) {
    this.#db = options.db;
    this.#logger = options.logger.child("PLUGIN");
    this.#credentials = options.credentials;
    this.#registry = new PluginRegistry({ logger: options.logger });
  }

  async load(): Promise<PluginManifest[]> {
    for (const row of await this.#db.select().from(plugins)) {
      try {
        this.#registry.upsert(toManifest(row));
      } catch (error) {
        // As with skills: one unreadable row never stops the application.
        this.#logger.warn("A stored plugin could not be read and was skipped", {
          pluginId: row.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return this.#registry.list();
  }

  list(): PluginManifest[] {
    return this.#registry.list();
  }

  async save(input: PluginManifestInput): Promise<PluginManifest> {
    const manifest = this.#registry.upsert(input);
    const now = new Date();
    const [existing] = await this.#db
      .select()
      .from(plugins)
      .where(eq(plugins.id, manifest.id))
      .limit(1);

    const values = {
      id: manifest.id,
      name: manifest.name,
      description: manifest.description,
      version: manifest.version,
      authentication: manifest.authentication as unknown as Record<string, unknown>,
      tools: manifest.tools as unknown[],
      permissions: manifest.permissions,
      capabilities: manifest.capabilities,
      enabledGlobally: existing?.enabledGlobally ?? false,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };

    await this.#db
      .insert(plugins)
      .values(values)
      .onConflictDoUpdate({ target: plugins.id, set: values });

    return manifest;
  }

  async assign(input: PluginAssignmentInput): Promise<void> {
    if (input.scope === "global") {
      await this.#db
        .update(plugins)
        .set({ enabledGlobally: input.enabled, updatedAt: new Date() })
        .where(eq(plugins.id, input.pluginId));
      return;
    }

    if (!input.scopeId) {
      throw new Error(`A ${input.scope} assignment needs a ${input.scope} id`);
    }

    if (input.scope === "workspace") {
      await this.#db
        .insert(workspacePlugins)
        .values({
          workspaceId: input.scopeId,
          pluginId: input.pluginId,
          enabled: input.enabled,
        })
        .onConflictDoUpdate({
          target: [workspacePlugins.workspaceId, workspacePlugins.pluginId],
          set: { enabled: input.enabled },
        });
      return;
    }

    await this.#db
      .insert(sessionPlugins)
      .values({
        sessionId: input.scopeId,
        pluginId: input.pluginId,
        enabled: input.enabled,
      })
      .onConflictDoUpdate({
        target: [sessionPlugins.sessionId, sessionPlugins.pluginId],
        set: { enabled: input.enabled },
      });
  }

  /** Connects an account once, for every plugin of that account type. */
  async connectAccount(input: {
    accountType: string;
    label: string;
    secret: string;
  }): Promise<PluginAccount> {
    const credential = await this.#credentials.store({
      label: input.label,
      kind: `plugin-account:${input.accountType}`,
      secret: input.secret,
    });

    const now = new Date();
    const account: PluginAccount = {
      id: `acct_${randomUUID()}`,
      accountType: input.accountType,
      label: input.label,
      credentialReference: credential.reference,
      createdAt: now,
      updatedAt: now,
    };

    await this.#db.insert(pluginAccounts).values(account);
    this.#logger.info("Plugin account connected", {
      accountType: account.accountType,
      serves: this.#registry.servedBy(account.accountType).length,
    });
    return account;
  }

  async accounts(): Promise<PluginAccount[]> {
    return (await this.#db.select().from(pluginAccounts)).map(toAccount);
  }

  async disconnectAccount(id: string): Promise<boolean> {
    const [row] = await this.#db
      .select()
      .from(pluginAccounts)
      .where(eq(pluginAccounts.id, id))
      .limit(1);
    if (!row) {
      return false;
    }
    await this.#db.delete(pluginAccounts).where(eq(pluginAccounts.id, id));
    // The secret goes with the account it belonged to.
    await this.#credentials.delete(row.credentialReference);
    return true;
  }

  /** The plugins a session may use, with the account serving each one. */
  async resolveForSession(input: {
    sessionId: string;
    workspaceId: string;
  }): Promise<ResolvedPlugin[]> {
    const globalRows = await this.#db.select().from(plugins);
    const workspaceRows = await this.#db
      .select()
      .from(workspacePlugins)
      .where(eq(workspacePlugins.workspaceId, input.workspaceId));
    const sessionRows = await this.#db
      .select()
      .from(sessionPlugins)
      .where(eq(sessionPlugins.sessionId, input.sessionId));

    return this.#registry.resolve(
      {
        global: globalRows.map((row) => ({
          pluginId: row.id,
          enabled: row.enabledGlobally,
        })),
        workspace: workspaceRows.map((row) => ({
          pluginId: row.pluginId,
          enabled: row.enabled,
        })),
        session: sessionRows.map((row) => ({
          pluginId: row.pluginId,
          enabled: row.enabled,
        })),
      },
      await this.accounts(),
    );
  }

  async assignmentsFor(input: {
    sessionId?: string;
    workspaceId?: string;
  }): Promise<{ global: Record<string, boolean>; session: Record<string, boolean> }> {
    const globalRows = await this.#db.select().from(plugins);
    const sessionRows = input.sessionId
      ? await this.#db
          .select()
          .from(sessionPlugins)
          .where(eq(sessionPlugins.sessionId, input.sessionId))
      : [];

    return {
      global: Object.fromEntries(globalRows.map((row) => [row.id, row.enabledGlobally])),
      session: Object.fromEntries(sessionRows.map((row) => [row.pluginId, row.enabled])),
    };
  }
}

function toManifest(row: PluginRow): PluginManifestInput {
  return {
    schemaVersion: 1,
    id: row.id,
    name: row.name,
    description: row.description,
    version: row.version,
    authentication: row.authentication as PluginManifest["authentication"],
    tools: row.tools as PluginManifest["tools"],
    permissions: row.permissions,
    capabilities: row.capabilities,
  };
}

function toAccount(row: PluginAccountRow): PluginAccount {
  return {
    id: row.id,
    accountType: row.accountType,
    label: row.label,
    credentialReference: row.credentialReference,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
