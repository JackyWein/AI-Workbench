import type { ProviderRegistry } from "@ai-workbench/provider-base";
import type { ModelInfo, StoredProviderConfig } from "@ai-workbench/shared";
import { createOpenAiCompatibleAdapter, type OpenAiCompatibleAdapter } from "./adapter.js";
import {
  parseOpenAiCompatibleProfile,
  type OpenAiCompatibleProfile,
} from "./profile.js";
import { readTransportSettings } from "./transport.js";
import type { FetchFn } from "./transport.js";

export interface RegisterCustomProvidersOptions {
  readonly fetchFn?: FetchFn;
}

export interface RegisterCustomProvidersResult {
  /** Ids that are now registered. */
  readonly registered: string[];
  /** Ids that were already registered and left alone. */
  readonly skipped: string[];
  /** Stored configs that are not valid custom providers, with reasons. */
  readonly rejected: Array<{ providerId: string; reason: string }>;
}

/**
 * Registers OpenAI-compatible providers from stored configurations (spec §16,
 * §17): whoever loads this package calls this with the registry, and no
 * generic service needs a change to support a new endpoint — if one does, the
 * abstraction is wrong.
 *
 * A stored config counts as a custom provider when it carries a base URL, a
 * credential reference, or an `openaiCompatible` manifest in its settings. The
 * manifest always carries `schemaVersion: 1`, so older entries can be migrated.
 */
export function registerCustomProviders(
  registry: ProviderRegistry,
  stored: readonly StoredProviderConfig[],
  options: RegisterCustomProvidersOptions = {},
): RegisterCustomProvidersResult {
  const registered: string[] = [];
  const skipped: string[] = [];
  const rejected: Array<{ providerId: string; reason: string }> = [];

  for (const config of stored) {
    const profile = toCustomProfile(config);
    if (!profile) {
      continue;
    }
    let parsed: OpenAiCompatibleProfile;
    try {
      parsed = parseOpenAiCompatibleProfile(profile);
    } catch (error) {
      rejected.push({
        providerId: config.providerId,
        reason: error instanceof Error ? error.message : String(error),
      });
      continue;
    }
    if (registry.has(parsed.id)) {
      skipped.push(parsed.id);
      continue;
    }
    const adapter: OpenAiCompatibleAdapter = createOpenAiCompatibleAdapter(
      parsed,
      options.fetchFn ? { fetchFn: options.fetchFn } : {},
    );
    registry.register(adapter);
    registered.push(parsed.id);
  }

  return { registered, skipped, rejected };
}

/**
 * Reads one stored config as a profile input. Returns null when the config is
 * not a custom OpenAI-compatible provider at all (a CLI entry, the mock, …).
 * User models alone never qualify: only a base URL, a credential reference or
 * an explicit manifest mark a custom provider, so nothing is ever guessed.
 */
function toCustomProfile(config: StoredProviderConfig): Record<string, unknown> | null {
  const manifest = readTransportSettings(config.settings);
  const baseUrl = config.baseUrl ?? manifest.baseUrl;
  const credentialReference = config.credentialReference ?? manifest.credentialReference;
  const hasManifest =
    typeof config.settings["openaiCompatible"] === "object" &&
    config.settings["openaiCompatible"] !== null;
  if (!baseUrl && !credentialReference && !hasManifest) {
    return null;
  }
  const models = Array.isArray(config.settings["models"])
    ? (config.settings["models"] as ModelInfo[])
    : [];
  const custom = config.settings["openaiCompatible"];
  const schemaVersion =
    typeof custom === "object" && custom !== null
      ? ((custom as Record<string, unknown>)["schemaVersion"] ?? 1)
      : 1;
  return {
    schemaVersion,
    id: config.providerId,
    displayName: displayNameOf(config),
    // Absent on purpose when unknown: parsing then fails and the entry lands in
    // `rejected` with a reason instead of running against a guessed endpoint.
    ...(baseUrl ? { baseUrl } : {}),
    ...(credentialReference ? { credentialReference } : {}),
    models,
    ...(config.defaultModel ? { defaultModel: config.defaultModel } : {}),
  };
}

function displayNameOf(config: StoredProviderConfig): string {
  const custom = config.settings["openaiCompatible"];
  if (typeof custom === "object" && custom !== null) {
    const displayName = (custom as Record<string, unknown>)["displayName"];
    if (typeof displayName === "string" && displayName.trim().length > 0) {
      return displayName;
    }
  }
  return config.providerId.startsWith("custom-")
    ? config.providerId.slice("custom-".length).replace(/-/g, " ")
    : config.providerId;
}
