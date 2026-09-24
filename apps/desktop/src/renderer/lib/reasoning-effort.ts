import type { ProviderSummary } from "@ai-workbench/shared";

/** Only offer levels reported for this model, or declared by its tool. */
export function reasoningEffortsFor(
  provider: ProviderSummary | undefined,
  modelId: string | null | undefined,
): string[] {
  if (!provider) return [];
  const model = provider.models.find((entry) => entry.id === modelId);
  const choices = model?.reasoningEfforts ?? provider.metadata.effortOptions ?? [];
  return [...new Set(choices.map((choice) => choice.trim()).filter(Boolean))];
}

export function effortLabel(value: string): string {
  return value === "xhigh" ? "Extra high" : value.charAt(0).toUpperCase() + value.slice(1);
}

export function needsEffortConfirmation(value: string): boolean {
  return value.toLowerCase() === "max" || value.toLowerCase() === "ultra";
}
