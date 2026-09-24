import type { IslandUsageRow } from "@ai-workbench/shared";

export interface ProviderUsageRows {
  readonly providerId: string;
  readonly name: string;
  readonly icon: string | null;
  readonly limits: IslandUsageRow[];
}

/** Every reported window stays visible, grouped below its provider. */
export function usageByProvider(rows: readonly IslandUsageRow[]): ProviderUsageRows[] {
  const byProvider = new Map<string, ProviderUsageRows>();
  for (const row of rows) {
    let provider = byProvider.get(row.providerId);
    if (!provider) {
      provider = { providerId: row.providerId, name: row.name, icon: row.icon, limits: [] };
      byProvider.set(row.providerId, provider);
    }
    provider.limits.push(row);
  }
  return [...byProvider.values()];
}
