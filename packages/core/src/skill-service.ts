import { eq } from "drizzle-orm";
import type { Database } from "@ai-workbench/database";
import {
  sessionSkills,
  skills,
  workspaceSkills,
  type SkillRow,
} from "@ai-workbench/database";
import { SkillManager } from "@ai-workbench/skills";
import type {
  EffectiveSkill,
  Logger,
  ProviderCapabilities,
  SkillAssignmentInput,
  SkillManifest,
  SkillManifestInput,
} from "@ai-workbench/shared";

export interface SkillServiceOptions {
  readonly db: Database;
  readonly logger: Logger;
}

/**
 * Persists skills and their scope assignments, and answers the only question
 * the rest of the application asks: which skills apply to this session
 * (spec §30).
 */
export class SkillService {
  readonly #db: Database;
  readonly #manager: SkillManager;

  constructor(options: SkillServiceOptions) {
    this.#db = options.db;
    this.#manager = new SkillManager({ logger: options.logger });
  }

  /** Loads every stored skill into memory. Called once at startup. */
  async load(): Promise<SkillManifest[]> {
    this.#manager.clear();
    for (const row of await this.#db.select().from(skills)) {
      this.#manager.upsert(toManifest(row));
    }
    return this.#manager.list();
  }

  list(): SkillManifest[] {
    return this.#manager.list();
  }

  async save(input: SkillManifestInput): Promise<SkillManifest> {
    const manifest = this.#manager.upsert(input);
    const now = new Date();
    const existing = await this.#row(manifest.id);

    const values = {
      id: manifest.id,
      name: manifest.name,
      description: manifest.description,
      version: manifest.version,
      instructions: manifest.instructions,
      requiredCapabilities: manifest.requiredCapabilities,
      tools: manifest.tools,
      mcpDependencies: manifest.mcpDependencies,
      metadata: manifest.metadata,
      source: manifest.source as Record<string, unknown>,
      enabledGlobally: existing?.enabledGlobally ?? false,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };

    await this.#db
      .insert(skills)
      .values(values)
      .onConflictDoUpdate({ target: skills.id, set: { ...values, createdAt: values.createdAt } });

    return manifest;
  }

  async delete(id: string): Promise<boolean> {
    this.#manager.unregister(id);
    await this.#db.delete(skills).where(eq(skills.id, id));
    return true;
  }

  /** Switches a skill on or off at one scope. */
  async assign(input: SkillAssignmentInput): Promise<void> {
    if (input.scope === "global") {
      await this.#db
        .update(skills)
        .set({ enabledGlobally: input.enabled, updatedAt: new Date() })
        .where(eq(skills.id, input.skillId));
      return;
    }

    if (!input.scopeId) {
      throw new Error(`A ${input.scope} assignment needs a ${input.scope} id`);
    }

    if (input.scope === "workspace") {
      await this.#db
        .insert(workspaceSkills)
        .values({
          workspaceId: input.scopeId,
          skillId: input.skillId,
          enabled: input.enabled,
        })
        .onConflictDoUpdate({
          target: [workspaceSkills.workspaceId, workspaceSkills.skillId],
          set: { enabled: input.enabled },
        });
      return;
    }

    await this.#db
      .insert(sessionSkills)
      .values({
        sessionId: input.scopeId,
        skillId: input.skillId,
        enabled: input.enabled,
      })
      .onConflictDoUpdate({
        target: [sessionSkills.sessionId, sessionSkills.skillId],
        set: { enabled: input.enabled },
      });
  }

  /** The skills that apply to a session, narrowest scope winning. */
  async resolveForSession(input: {
    sessionId: string;
    workspaceId: string;
    capabilities?: ProviderCapabilities;
  }): Promise<EffectiveSkill[]> {
    const globalRows = await this.#db.select().from(skills);
    const workspaceRows = await this.#db
      .select()
      .from(workspaceSkills)
      .where(eq(workspaceSkills.workspaceId, input.workspaceId));
    const sessionRows = await this.#db
      .select()
      .from(sessionSkills)
      .where(eq(sessionSkills.sessionId, input.sessionId));

    const effective = this.#manager.resolve({
      global: globalRows.map((row) => ({
        skillId: row.id,
        enabled: row.enabledGlobally,
      })),
      workspace: workspaceRows.map((row) => ({
        skillId: row.skillId,
        enabled: row.enabled,
      })),
      session: sessionRows.map((row) => ({
        skillId: row.skillId,
        enabled: row.enabled,
      })),
    });

    return input.capabilities
      ? this.#manager.filterByCapabilities(effective, input.capabilities)
      : effective;
  }

  buildInstructions(effective: readonly EffectiveSkill[]): string {
    return this.#manager.buildInstructions(effective);
  }

  /** Scope decisions for the UI, so a toggle can show where it comes from. */
  async assignmentsFor(input: {
    sessionId?: string;
    workspaceId?: string;
  }): Promise<{
    global: Record<string, boolean>;
    workspace: Record<string, boolean>;
    session: Record<string, boolean>;
  }> {
    const globalRows = await this.#db.select().from(skills);
    const workspaceRows = input.workspaceId
      ? await this.#db
          .select()
          .from(workspaceSkills)
          .where(eq(workspaceSkills.workspaceId, input.workspaceId))
      : [];
    const sessionRows = input.sessionId
      ? await this.#db
          .select()
          .from(sessionSkills)
          .where(eq(sessionSkills.sessionId, input.sessionId))
      : [];

    return {
      global: Object.fromEntries(globalRows.map((row) => [row.id, row.enabledGlobally])),
      workspace: Object.fromEntries(
        workspaceRows.map((row) => [row.skillId, row.enabled]),
      ),
      session: Object.fromEntries(sessionRows.map((row) => [row.skillId, row.enabled])),
    };
  }

  async #row(id: string): Promise<SkillRow | undefined> {
    const [row] = await this.#db.select().from(skills).where(eq(skills.id, id)).limit(1);
    return row;
  }
}

function toManifest(row: SkillRow): SkillManifestInput {
  return {
    schemaVersion: 1,
    id: row.id,
    name: row.name,
    description: row.description,
    version: row.version,
    instructions: row.instructions,
    requiredCapabilities: row.requiredCapabilities as SkillManifest["requiredCapabilities"],
    tools: row.tools,
    mcpDependencies: row.mcpDependencies,
    metadata: row.metadata,
    source: row.source as SkillManifest["source"],
  };
}
