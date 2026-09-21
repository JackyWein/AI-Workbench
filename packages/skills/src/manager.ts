import type { Logger, ProviderCapabilities } from "@ai-workbench/shared";
import {
  parseSkill,
  type EffectiveSkill,
  type SkillAssignment,
  type SkillManifest,
  type SkillScope,
  type SkillScopes,
} from "./manifest.js";

export class DuplicateSkillError extends Error {
  constructor(id: string) {
    super(`A skill with id "${id}" is already registered`);
    this.name = "DuplicateSkillError";
  }
}

export interface SkillManagerOptions {
  readonly logger: Logger;
}

/** Narrowest scope first: a session decision beats a workspace one. */
const PRECEDENCE: readonly SkillScope[] = ["session", "workspace", "global"];

/**
 * Holds the known skills and computes which ones actually apply to a session
 * (spec §30). Resolution is pure: the same inputs always give the same set,
 * which is what makes it testable and predictable.
 */
export class SkillManager {
  readonly #skills = new Map<string, SkillManifest>();
  readonly #logger: Logger;

  constructor(options: SkillManagerOptions) {
    this.#logger = options.logger.child("SKILL");
  }

  register(input: unknown): SkillManifest {
    const skill = parseSkill(input);
    if (this.#skills.has(skill.id)) {
      throw new DuplicateSkillError(skill.id);
    }
    this.#skills.set(skill.id, skill);
    this.#logger.debug("Skill registered", { skillId: skill.id });
    return skill;
  }

  /** Registers or replaces, used when skills are reloaded from disk. */
  upsert(input: unknown): SkillManifest {
    const skill = parseSkill(input);
    this.#skills.set(skill.id, skill);
    return skill;
  }

  unregister(id: string): boolean {
    return this.#skills.delete(id);
  }

  get(id: string): SkillManifest | undefined {
    return this.#skills.get(id);
  }

  list(): SkillManifest[] {
    return [...this.#skills.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  clear(): void {
    this.#skills.clear();
  }

  /**
   * Computes the effective skill set. A narrower scope wins outright, so a
   * session can switch off something the workspace turned on.
   */
  resolve(scopes: SkillScopes): EffectiveSkill[] {
    const decisions = new Map<string, { enabled: boolean; scope: SkillScope }>();

    for (const scope of PRECEDENCE) {
      for (const assignment of assignmentsOf(scopes, scope)) {
        if (!decisions.has(assignment.skillId)) {
          decisions.set(assignment.skillId, {
            enabled: assignment.enabled,
            scope,
          });
        }
      }
    }

    const effective: EffectiveSkill[] = [];
    for (const [skillId, decision] of decisions) {
      if (!decision.enabled) {
        continue;
      }
      const skill = this.#skills.get(skillId);
      if (!skill) {
        // A scope may still reference a skill that has been removed.
        this.#logger.debug("Enabled skill is unknown", { skillId });
        continue;
      }
      effective.push({ skill, decidedBy: decision.scope });
    }

    return effective.sort((a, b) => a.skill.name.localeCompare(b.skill.name));
  }

  /** Drops skills whose required capabilities the provider does not have. */
  filterByCapabilities(
    skills: readonly EffectiveSkill[],
    capabilities: ProviderCapabilities,
  ): EffectiveSkill[] {
    return skills.filter((entry) =>
      entry.skill.requiredCapabilities.every((capability) =>
        capabilities.supported.includes(capability),
      ),
    );
  }

  /** Builds the system instructions handed to a provider session. */
  buildInstructions(skills: readonly EffectiveSkill[]): string {
    if (skills.length === 0) {
      return "";
    }
    return skills
      .map((entry) => `# ${entry.skill.name}\n\n${entry.skill.instructions.trim()}`)
      .join("\n\n---\n\n");
  }
}

function assignmentsOf(
  scopes: SkillScopes,
  scope: SkillScope,
): readonly SkillAssignment[] {
  switch (scope) {
    case "session":
      return scopes.session ?? [];
    case "workspace":
      return scopes.workspace ?? [];
    default:
      return scopes.global ?? [];
  }
}
