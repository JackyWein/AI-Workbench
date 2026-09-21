import type { Logger } from "@ai-workbench/shared";
import {
  parsePlugin,
  type PluginAccount,
  type PluginAssignment,
  type PluginManifest,
  type PluginScope,
  type PluginScopes,
  type ResolvedPlugin,
} from "./manifest.js";

export class DuplicatePluginError extends Error {
  constructor(id: string) {
    super(`A plugin with id "${id}" is already registered`);
    this.name = "DuplicatePluginError";
  }
}

/** Narrowest scope first: an agent decision beats a session one. */
const PRECEDENCE: readonly PluginScope[] = [
  "agent",
  "session",
  "workspace",
  "global",
];

export interface PluginRegistryOptions {
  readonly logger: Logger;
}

/**
 * Holds plugin manifests and works out which ones a session or agent may use,
 * and which account serves each one (spec §33–§35).
 */
export class PluginRegistry {
  readonly #plugins = new Map<string, PluginManifest>();
  readonly #logger: Logger;

  constructor(options: PluginRegistryOptions) {
    this.#logger = options.logger.child("PLUGIN");
  }

  register(input: unknown): PluginManifest {
    const plugin = parsePlugin(input);
    if (this.#plugins.has(plugin.id)) {
      throw new DuplicatePluginError(plugin.id);
    }
    this.#plugins.set(plugin.id, plugin);
    this.#logger.debug("Plugin registered", { pluginId: plugin.id });
    return plugin;
  }

  upsert(input: unknown): PluginManifest {
    const plugin = parsePlugin(input);
    this.#plugins.set(plugin.id, plugin);
    return plugin;
  }

  unregister(id: string): boolean {
    return this.#plugins.delete(id);
  }

  get(id: string): PluginManifest | undefined {
    return this.#plugins.get(id);
  }

  list(): PluginManifest[] {
    return [...this.#plugins.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Plugins that a single account would serve, by account type. */
  servedBy(accountType: string): PluginManifest[] {
    return this.list().filter(
      (plugin) => plugin.authentication.accountType === accountType,
    );
  }

  /**
   * Resolves which plugins apply, and attaches the account each one would use.
   * A plugin that needs an account and has none is reported as not usable
   * rather than silently dropped, so the UI can explain why.
   */
  resolve(scopes: PluginScopes, accounts: readonly PluginAccount[]): ResolvedPlugin[] {
    const decisions = new Map<string, { enabled: boolean; scope: PluginScope }>();

    for (const scope of PRECEDENCE) {
      for (const assignment of assignmentsOf(scopes, scope)) {
        if (!decisions.has(assignment.pluginId)) {
          decisions.set(assignment.pluginId, {
            enabled: assignment.enabled,
            scope,
          });
        }
      }
    }

    const resolved: ResolvedPlugin[] = [];
    for (const [pluginId, decision] of decisions) {
      if (!decision.enabled) {
        continue;
      }
      const plugin = this.#plugins.get(pluginId);
      if (!plugin) {
        this.#logger.debug("Enabled plugin is unknown", { pluginId });
        continue;
      }

      const account = this.accountFor(plugin, accounts);
      const needsAccount = plugin.authentication.kind !== "none";

      resolved.push({
        plugin,
        decidedBy: decision.scope,
        account,
        usable: !needsAccount || account !== null,
      });
    }

    return resolved.sort((a, b) => a.plugin.name.localeCompare(b.plugin.name));
  }

  /** The account that serves a plugin, or null when none is connected. */
  accountFor(
    plugin: PluginManifest,
    accounts: readonly PluginAccount[],
  ): PluginAccount | null {
    const accountType = plugin.authentication.accountType;
    if (plugin.authentication.kind === "none" || !accountType) {
      return null;
    }
    return accounts.find((account) => account.accountType === accountType) ?? null;
  }
}

function assignmentsOf(
  scopes: PluginScopes,
  scope: PluginScope,
): readonly PluginAssignment[] {
  switch (scope) {
    case "agent":
      return scopes.agent ?? [];
    case "session":
      return scopes.session ?? [];
    case "workspace":
      return scopes.workspace ?? [];
    default:
      return scopes.global ?? [];
  }
}
