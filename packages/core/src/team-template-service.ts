import { asc, eq } from "drizzle-orm";
import type { Database } from "@ai-workbench/database";
import { teamTemplates, type TeamTemplateRow } from "@ai-workbench/database";
import {
  teamTemplateContentSchema,
  teamTemplateMemberSchema,
  type TeamTemplate,
  type TeamTemplateContent,
} from "@ai-workbench/shared";
import { createId } from "./ids.js";

/**
 * Team templates the person keeps (FutureFeatures 7): who is on a team and
 * how each member works, without a running team. The built-in templates stay
 * in the window; these appear next to them.
 */
export class TeamTemplateService {
  readonly #db: Database;

  constructor(options: { readonly db: Database }) {
    this.#db = options.db;
  }

  async list(): Promise<TeamTemplate[]> {
    const rows = await this.#db.select().from(teamTemplates).orderBy(asc(teamTemplates.createdAt));
    return rows.flatMap((row) => {
      const template = toTemplate(row);
      return template ? [template] : [];
    });
  }

  /** Stores a template; with an id it replaces that one. Checked before it is kept. */
  async save(input: TeamTemplateContent & { readonly id?: string }): Promise<TeamTemplate> {
    const content = teamTemplateContentSchema.parse(input);
    const now = new Date();
    const existing = input.id
      ? (await this.#db.select().from(teamTemplates).where(eq(teamTemplates.id, input.id)).limit(1))[0]
      : undefined;
    const row: TeamTemplateRow = {
      id: existing?.id ?? createId("tpl"),
      name: content.name,
      summary: content.summary,
      members: content.members,
      leadIndex: content.leadIndex,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    if (existing) {
      await this.#db.update(teamTemplates).set(row).where(eq(teamTemplates.id, row.id));
    } else {
      await this.#db.insert(teamTemplates).values(row);
    }
    const saved = toTemplate(row);
    if (!saved) {
      throw new Error("The template could not be stored.");
    }
    return saved;
  }

  async delete(id: string): Promise<boolean> {
    const existing = await this.#db.select().from(teamTemplates).where(eq(teamTemplates.id, id)).limit(1);
    if (existing.length === 0) {
      return false;
    }
    await this.#db.delete(teamTemplates).where(eq(teamTemplates.id, id));
    return true;
  }
}

function toTemplate(row: TeamTemplateRow): TeamTemplate | null {
  const members = Array.isArray(row.members)
    ? row.members.flatMap((member) => {
        const parsed = teamTemplateMemberSchema.safeParse(member);
        return parsed.success ? [parsed.data] : [];
      })
    : [];
  if (members.length === 0) {
    return null;
  }
  return {
    id: row.id,
    name: row.name,
    summary: row.summary,
    members,
    leadIndex: row.leadIndex < members.length ? row.leadIndex : 0,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
