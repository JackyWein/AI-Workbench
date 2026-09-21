import type { ProviderSummary } from "@ai-workbench/shared";

/**
 * What a provider entry is called where space is short. An account entry
 * keeps the tool's own display name, so the account label is added to tell
 * two sign-ins of the same tool apart: "Claude Code · Arbeit".
 */
export function providerLabel(provider: ProviderSummary): string {
  const account = provider.metadata.account;
  return account
    ? `${provider.metadata.displayName} · ${account.label}`
    : provider.metadata.displayName;
}

/** The tool a provider entry belongs to; its accounts share the family. */
export function familyOf(provider: ProviderSummary): string {
  return provider.metadata.family ?? provider.metadata.id;
}
