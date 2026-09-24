import type { ModelInfo } from "@ai-workbench/shared";
import type { AppServerModel } from "./app-server.js";

/**
 * Turns the app server's model list into the application's model entries.
 *
 * Hidden models are ones Codex keeps out of its own picker (older or internal
 * ones); they are dropped unless nothing else is left, because an account that
 * only has hidden models can still use them and an empty picker would say it
 * cannot. Returns null when the tool reported no usable model at all, so the
 * adapter falls back to what the profile knows instead (spec §56).
 */
export function toModelInfos(models: readonly AppServerModel[]): ModelInfo[] | null {
  const visible = models.filter((model) => model.hidden !== true);
  const chosen = visible.length > 0 ? visible : models;
  const seen = new Set<string>();
  const result: ModelInfo[] = [];

  for (const model of chosen) {
    const info = toModelInfo(model);
    if (seen.has(info.id)) {
      continue;
    }
    seen.add(info.id);
    result.push(info);
  }
  return result.length > 0 ? result : null;
}

function toModelInfo(model: AppServerModel): ModelInfo {
  const id = nonEmpty(model.model) ?? model.id;
  const efforts = unique(
    (model.supportedReasoningEfforts ?? []).map((option) => option.reasoningEffort),
  );
  const defaultEffort = nonEmpty(model.defaultReasoningEffort);
  const description = nonEmpty(model.description);

  return {
    id,
    displayName: nonEmpty(model.displayName) ?? id,
    ...(description === undefined ? {} : { description }),
    ...(model.isDefault === true ? { isDefault: true } : {}),
    ...(efforts.length > 0 ? { reasoningEfforts: efforts } : {}),
    ...(defaultEffort === undefined ? {} : { defaultReasoningEffort: defaultEffort }),
    ...(offersFastTier(model) ? { supportsFastMode: true } : {}),
    source: "provider",
  };
}

/**
 * Codex names its faster service tier "Fast" (id "priority"); older releases
 * listed it as an additional speed tier called "fast". Only what the tool says
 * counts: no tier, no claim.
 */
function offersFastTier(model: AppServerModel): boolean {
  const tiers = model.serviceTiers ?? [];
  if (tiers.some((tier) => /\bfast\b/i.test(tier.name ?? ""))) {
    return true;
  }
  return (model.additionalSpeedTiers ?? []).some((tier) => tier.toLowerCase() === "fast");
}

function nonEmpty(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values.filter((value) => value.length > 0))];
}
