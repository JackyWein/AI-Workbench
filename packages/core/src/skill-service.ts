import { eq } from "drizzle-orm";
import type { Database } from "@ai-workbench/database";
import {
  sessionSkills,
  skills,
  workspaceSkills,
  type SkillRow,
} from "@ai-workbench/database";
import { SkillManager } from "@ai-workbench/skills";
import { skillFolderOf, writeSkillsLibrary } from "@ai-workbench/mcp";
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
  /**
   * Where the skills are written for the skills server, which lets every tool
   * load one when a task needs it. Without it skills only reach sessions as
   * full instructions.
   */
  readonly libraryDirectory?: string;
  /** Called after the library changed, so the server can be told. */
  readonly onLibraryChanged?: () => void;
}

/**
 * Persists skills and their scope assignments, and answers the only question
 * the rest of the application asks: which skills apply to this session
 * (spec §30).
 */
export class SkillService {
  readonly #db: Database;
  readonly #logger: Logger;
  readonly #manager: SkillManager;
  readonly #libraryDirectory: string | undefined;
  readonly #onLibraryChanged: (() => void) | undefined;
  #syncing: Promise<void> = Promise.resolve();

  constructor(options: SkillServiceOptions) {
    this.#db = options.db;
    this.#logger = options.logger.child("SKILL");
    this.#manager = new SkillManager({ logger: options.logger });
    this.#libraryDirectory = options.libraryDirectory;
    this.#onLibraryChanged = options.onLibraryChanged;
  }

  /** Where the library is, when there is one. */
  get libraryDirectory(): string | undefined {
    return this.#libraryDirectory;
  }

  /**
   * Writes every skill to the library folder: which exist, which are switched
   * on for everyone, and each one's text. Runs one at a time, so quick edits
   * cannot interleave; a failure is logged and never fails the edit.
   */
  syncLibrary(): Promise<void> {
    const directory = this.#libraryDirectory;
    if (!directory) {
      return Promise.resolve();
    }
    this.#syncing = this.#syncing.then(async () => {
      try {
        const rows = await this.#db.select().from(skills);
        await writeSkillsLibrary(
          directory,
          rows.map((row) => ({
            id: row.id,
            name: row.name,
            description: row.description,
            instructions: row.instructions,
            enabled: row.enabledGlobally,
            folder: skillFolderOf(
              typeof (row.source as { path?: unknown }).path === "string"
                ? ((row.source as { path?: string }).path)
                : undefined,
            ),
          })),
        );
        this.#onLibraryChanged?.();
      } catch (error) {
        this.#logger.warn("The skills library could not be written", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    });
    return this.#syncing;
  }

  /** Ids of the skills switched on for everyone — the ones the library offers. */
  async globallyEnabled(): Promise<Set<string>> {
    const rows = await this.#db.select({ id: skills.id, enabled: skills.enabledGlobally }).from(skills);
    return new Set(rows.filter((row) => row.enabled).map((row) => row.id));
  }

  /**
   * The on-demand form of a session's skills: one line each, loaded in full
   * with skill_read when a task needs them. Skills the library already
   * offers everyone are left out, so nothing is said twice.
   */
  buildListing(effective: readonly EffectiveSkill[], alreadyOffered: ReadonlySet<string>): string {
    const extra = effective.filter((entry) => !alreadyOffered.has(entry.skill.id));
    if (extra.length === 0) {
      return "";
    }
    return [
      "Also available here (load with skill_read before a task that matches):",
      ...extra.map(
        (entry) => `- ${entry.skill.name}: ${entry.skill.description.replace(/\s+/g, " ").slice(0, 300)}`,
      ),
    ].join("\n");
  }

  /** Loads every stored skill into memory. Called once at startup. */
  async load(): Promise<SkillManifest[]> {
    this.#manager.clear();
    for (const row of await this.#db.select().from(skills)) {
      try {
        this.#manager.upsert(toManifest(row));
      } catch (error) {
        // One stored skill that no longer reads (an older version's, a hand
        // edit) must not keep the application from starting. It stays in the
        // database, untouched, and is reported.
        this.#logger.warn("A stored skill could not be read and was skipped", {
          skillId: row.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
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

    void this.syncLibrary();
    return manifest;
  }

  async delete(id: string): Promise<boolean> {
    this.#manager.unregister(id);
    await this.#db.delete(skills).where(eq(skills.id, id));
    void this.syncLibrary();
    return true;
  }

  /** Switches a skill on or off at one scope. */
  async assign(input: SkillAssignmentInput): Promise<void> {
    if (input.scope === "global") {
      await this.#db
        .update(skills)
        .set({ enabledGlobally: input.enabled, updatedAt: new Date() })
        .where(eq(skills.id, input.skillId));
      void this.syncLibrary();
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

  /**
   * The skills a team member works with: those on for its run's workspace
   * and session, plus the ones picked for the member itself in the team —
   * each only when the member's tool can do what the skill needs.
   */
  async resolveForMember(input: {
    sessionId: string | null;
    workspaceId: string;
    memberSkillIds: readonly string[];
    capabilities?: ProviderCapabilities;
  }): Promise<EffectiveSkill[]> {
    const effective = await this.resolveForSession({
      sessionId: input.sessionId ?? "",
      workspaceId: input.workspaceId,
    });
    const have = new Set(effective.map((entry) => entry.skill.id));
    const own = this.list()
      .filter((skill) => input.memberSkillIds.includes(skill.id) && !have.has(skill.id))
      .map((skill) => ({ skill, decidedBy: "session" as const }));
    const all = [...effective, ...own];
    return input.capabilities ? this.#manager.filterByCapabilities(all, input.capabilities) : all;
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
