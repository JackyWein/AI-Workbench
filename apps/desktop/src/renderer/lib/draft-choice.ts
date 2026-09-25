import type { ProviderSummary } from "@ai-workbench/shared";
import { reasoningEffortsFor } from "./reasoning-effort.js";

/** Which tool, model and effort something drafted by AI runs on. */
export interface DraftChoice {
  readonly providerId: string;
  /** Empty for the tool's default model. */
  readonly modelId: string;
  /** Empty for the tool's default effort. */
  readonly effort: string;
}

/** What a draft is for; each remembers its own last choice. */
export type DraftPurpose = "skill" | "team-template" | "schedule";

const STORAGE_PREFIX = "ai-workbench.draft-choice.";

/** Tools that can draft right now: on, installed, signed in, able to chat. */
export function draftingProviders(providers: readonly ProviderSummary[]): ProviderSummary[] {
  return providers.filter(
    (provider) =>
      provider.enabled &&
      provider.capabilities.supported.includes("chat") &&
      provider.installation.state === "installed" &&
      provider.auth.state !== "authenticationRequired" &&
      provider.auth.state !== "authenticationExpired",
  );
}

/**
 * The choice to start from: the one remembered for this purpose while its
 * tool, model and effort still exist, otherwise the first usable tool with
 * its default model.
 */
export function initialDraftChoice(
  purpose: DraftPurpose,
  usable: readonly ProviderSummary[],
  stored: string | null = readStored(purpose),
): DraftChoice {
  const fallback: DraftChoice = { providerId: usable[0]?.metadata.id ?? "", modelId: "", effort: "" };
  if (!stored) {
    return fallback;
  }
  try {
    const parsed = JSON.parse(stored) as Partial<DraftChoice>;
    const provider = usable.find((entry) => entry.metadata.id === parsed.providerId);
    if (!provider) {
      return fallback;
    }
    const modelId =
      typeof parsed.modelId === "string" && provider.models.some((model) => model.id === parsed.modelId)
        ? parsed.modelId
        : "";
    const effort =
      typeof parsed.effort === "string" && reasoningEffortsFor(provider, modelId || null).includes(parsed.effort)
        ? parsed.effort
        : "";
    return { providerId: provider.metadata.id, modelId, effort };
  } catch {
    return fallback;
  }
}

/** Keeps the choice for next time; a browser that refuses storage just forgets. */
export function rememberDraftChoice(purpose: DraftPurpose, choice: DraftChoice): void {
  try {
    window.localStorage.setItem(`${STORAGE_PREFIX}${purpose}`, JSON.stringify(choice));
  } catch {
    // Remembering is a convenience only.
  }
}

function readStored(purpose: DraftPurpose): string | null {
  try {
    return window.localStorage.getItem(`${STORAGE_PREFIX}${purpose}`);
  } catch {
    return null;
  }
}
