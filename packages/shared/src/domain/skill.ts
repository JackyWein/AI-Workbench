import { z } from "zod";
import { providerCapabilitySchema } from "./provider.js";

/**
 * A skill is provider-neutral instruction material (spec §29). It says what the
 * agent should know or how it should work, never how a particular provider is
 * invoked — that is what keeps the same skill usable by every provider.
 */
export const skillManifestSchema = z.object({
  /** Bumped when the manifest shape changes, so skills can be migrated. */
  schemaVersion: z.literal(1),
  id: z
    .string()
    .min(1)
    .max(100)
    .regex(/^[a-z0-9][a-z0-9-]*$/, "use lowercase letters, digits and hyphens"),
  name: z.string().min(1).max(200),
  description: z.string().max(2000).default(""),
  version: z.string().min(1).default("1.0.0"),
  /** The material handed to the provider as system instructions. */
  instructions: z.string().min(1),
  /** Providers lacking these capabilities cannot use the skill. */
  requiredCapabilities: z.array(providerCapabilitySchema).default([]),
  tools: z.array(z.string()).default([]),
  mcpDependencies: z.array(z.string()).default([]),
  metadata: z.record(z.unknown()).default({}),
  source: z
    .object({
      /** "authored": written (or drafted and kept) in the application. */
      kind: z.enum(["builtin", "directory", "import", "authored"]),
      path: z.string().optional(),
      importer: z.string().optional(),
    })
    .default({ kind: "builtin" }),
});

export type SkillManifest = z.infer<typeof skillManifestSchema>;
export type SkillManifestInput = z.input<typeof skillManifestSchema>;

export function parseSkill(input: unknown): SkillManifest {
  return skillManifestSchema.parse(input);
}

/** Scopes a skill can be switched on or off at (spec §30). */
export const skillScopeSchema = z.enum(["global", "workspace", "session"]);
export type SkillScope = z.infer<typeof skillScopeSchema>;

export const skillAssignmentSchema = z.object({
  skillId: z.string().min(1),
  enabled: z.boolean(),
});
export type SkillAssignment = z.infer<typeof skillAssignmentSchema>;

export const skillScopesSchema = z.object({
  global: z.array(skillAssignmentSchema).optional(),
  workspace: z.array(skillAssignmentSchema).optional(),
  session: z.array(skillAssignmentSchema).optional(),
});
export type SkillScopes = z.infer<typeof skillScopesSchema>;

export const effectiveSkillSchema = z.object({
  skill: skillManifestSchema,
  /** The scope that decided the outcome. */
  decidedBy: skillScopeSchema,
});
export type EffectiveSkill = z.infer<typeof effectiveSkillSchema>;

/** Switching a skill on or off at one scope (spec §30). */
export const skillAssignmentInputSchema = z.object({
  skillId: z.string().min(1),
  scope: skillScopeSchema,
  /** Required for the workspace and session scopes. */
  scopeId: z.string().min(1).optional(),
  enabled: z.boolean(),
});
export type SkillAssignmentInput = z.infer<typeof skillAssignmentInputSchema>;

/** A skill one of the person's tools keeps, offered for import (spec §31). */
export const discoveredSkillSchema = z.object({
  /** The skill's folder, holding its SKILL.md. */
  path: z.string().min(1),
  name: z.string().min(1),
  description: z.string(),
  /** Where the tool keeps it, in words. */
  source: z.string(),
  providerId: z.string().min(1),
  providerName: z.string().min(1),
  /** Already imported from exactly this folder. */
  imported: z.boolean(),
});
export type DiscoveredSkill = z.infer<typeof discoveredSkillSchema>;

/** A skill a provider drafted, for the person to edit before saving. */
export const skillDraftSchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(2000),
  instructions: z.string().min(1),
  /** The model that wrote it, when known. */
  modelId: z.string().optional(),
});
export type SkillDraftResult = z.infer<typeof skillDraftSchema>;
