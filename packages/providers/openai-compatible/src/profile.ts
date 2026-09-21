import { z } from "zod";
import { modelInfoSchema, type ModelInfo } from "@ai-workbench/shared";

/**
 * An OpenAI-compatible provider as data, mirroring how `@ai-workbench/provider-cli`
 * keeps CLI providers in a validated, versioned profile (spec §16).
 *
 * Everything the UI collects for a custom provider — name, base URL, credential
 * reference, model ids — becomes one of these through `createCustomProfile`, so a
 * user can add an endpoint (Ollama, llama.cpp, vLLM, OpenRouter, a company
 * gateway, …) without any code change. This module stays free of Node APIs on
 * purpose: the Providers screen imports the parser directly.
 */
export const openAiCompatibleProfileSchema = z.object({
  /** Bumped when the profile shape changes, so profiles can be migrated. */
  schemaVersion: z.literal(1),
  /** Stable id, e.g. `custom-local-llama`. */
  id: z.string().min(1).max(100).regex(/^\S+$/),
  displayName: z.string().min(1).max(100),
  description: z.string().max(500).optional(),
  /** OpenAI-compatible base URL, e.g. `http://localhost:11434/v1`. */
  baseUrl: z.string().url().max(2000),
  /**
   * Reference into the CredentialManager. Never a raw secret (spec §57); the
   * renderer only ever carries this reference, resolution happens in the main
   * process. Absent for servers that need no key.
   */
  credentialReference: z.string().min(1).max(300).optional(),
  /** Models this endpoint serves. Empty means "ask the server". */
  models: z.array(modelInfoSchema).default([]),
  defaultModel: z.string().min(1).optional(),
  timeoutMs: z.number().int().positive().default(120_000),
});

export type OpenAiCompatibleProfile = z.infer<typeof openAiCompatibleProfileSchema>;
export type OpenAiCompatibleProfileInput = z.input<typeof openAiCompatibleProfileSchema>;

/** Validates unknown input into a profile. Throws a ZodError when invalid. */
export function parseOpenAiCompatibleProfile(input: unknown): OpenAiCompatibleProfile {
  return openAiCompatibleProfileSchema.parse(input);
}

/** Turns a display name into a stable provider id (`My LLM` → `custom-my-llm`). */
export function slugifyCustomProviderId(displayName: string): string {
  const slug =
    displayName
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "server";
  return `custom-${slug}`;
}

/** An http(s) URL without trailing slashes, or null when it is not one. */
export function normalizeBaseUrl(value: string): string | null {
  const trimmed = value.trim().replace(/\/+$/, "");
  if (trimmed.length === 0) {
    return null;
  }
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return null;
    }
    return trimmed;
  } catch {
    return null;
  }
}

export interface CreateCustomProfileInput {
  readonly displayName: string;
  readonly baseUrl: string;
  readonly credentialReference?: string;
  readonly models: readonly ModelInfo[];
  readonly defaultModel?: string;
}

/**
 * Builds the manifest the Custom section of the Providers screen persists:
 * validated, normalized, stamped with `schemaVersion: 1`, first model default.
 * Throws an Error with a human-readable message when the form is unusable.
 */
export function createCustomProfile(input: CreateCustomProfileInput): OpenAiCompatibleProfile {
  const displayName = input.displayName.trim();
  if (displayName.length === 0) {
    throw new Error("Give the provider a name.");
  }
  const baseUrl = normalizeBaseUrl(input.baseUrl);
  if (!baseUrl) {
    throw new Error("The base URL must be an http(s) URL, e.g. http://localhost:11434/v1.");
  }
  if (input.models.length === 0) {
    throw new Error("Add at least one model id; the server cannot choose one for you.");
  }
  const credentialReference = input.credentialReference?.trim();
  const defaultModel =
    input.defaultModel?.trim() || input.models.find((model) => model.isDefault)?.id || input.models[0]?.id;

  return parseOpenAiCompatibleProfile({
    schemaVersion: 1,
    id: slugifyCustomProviderId(displayName),
    displayName,
    baseUrl,
    ...(credentialReference ? { credentialReference } : {}),
    models: input.models.map((model, index) => ({
      ...model,
      ...(index === 0 && !model.isDefault ? { isDefault: true } : {}),
    })),
    ...(defaultModel ? { defaultModel } : {}),
  });
}

/** "id = Display name" per line, the same round-trip the CLI section uses. */
export function formatCustomModels(models: readonly ModelInfo[]): string {
  return models
    .map((model) =>
      model.displayName && model.displayName !== model.id
        ? `${model.id} = ${model.displayName}`
        : model.id,
    )
    .join("\n");
}

/** Parses the textarea back into model entries; the first one is the default. */
export function parseCustomModels(text: string): ModelInfo[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line, index) => {
      const [rawId, ...rest] = line.split("=");
      const id = (rawId ?? "").trim();
      const displayName = rest.join("=").trim();
      return {
        id,
        displayName: displayName.length > 0 ? displayName : id,
        ...(index === 0 ? { isDefault: true } : {}),
      };
    })
    .filter((model) => model.id.length > 0);
}
