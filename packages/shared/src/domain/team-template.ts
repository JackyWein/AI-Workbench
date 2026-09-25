import { z } from "zod";

/**
 * One member of a team template: who it is, the role the team sees, how it
 * works — never which tool to use, that is the person's choice — and the tool
 * and model suggested for it, which the editor only takes when available.
 */
export const teamTemplateMemberSchema = z.object({
  name: z.string().trim().min(1).max(80),
  role: z.string().trim().max(300).default(""),
  instructions: z.string().trim().max(8000).default(""),
  providerId: z.string().min(1).max(200).optional(),
  modelId: z.string().min(1).max(200).optional(),
  reasoningEffort: z.string().min(1).max(40).optional(),
});
export type TeamTemplateMember = z.infer<typeof teamTemplateMemberSchema>;

const templateFields = {
  name: z.string().trim().min(1).max(80),
  summary: z.string().trim().max(300).default(""),
  members: z.array(teamTemplateMemberSchema).min(1, "A team needs at least one member").max(8, "A team has at most 8 members"),
  /** Which member leads; the first when not said. */
  leadIndex: z.number().int().min(0).default(0),
};

const leadIsAMember = (template: { members: readonly unknown[]; leadIndex: number }): boolean =>
  template.leadIndex < template.members.length;
const LEAD_MESSAGE = { message: "The lead must be one of the members", path: ["leadIndex"] };

/** A template's content: what a draft, a save or an import carries. */
export const teamTemplateContentSchema = z.object(templateFields).refine(leadIsAMember, LEAD_MESSAGE);
export type TeamTemplateContent = z.infer<typeof teamTemplateContentSchema>;

/** A template the person keeps, next to the built-in ones. */
export const teamTemplateSchema = z
  .object({
    id: z.string().min(1),
    ...templateFields,
    createdAt: z.coerce.date(),
    updatedAt: z.coerce.date(),
  })
  .refine(leadIsAMember, LEAD_MESSAGE);
export type TeamTemplate = z.infer<typeof teamTemplateSchema>;

/** A template a model drafted, for the person to read before saving. */
export const teamTemplateDraftSchema = z
  .object({ ...templateFields, modelId: z.string().optional() })
  .refine(leadIsAMember, LEAD_MESSAGE);
export type TeamTemplateDraft = z.infer<typeof teamTemplateDraftSchema>;

/** What an exported file says it is, so an import knows what it reads. */
export const TEAM_TEMPLATE_FORMAT = "ai-workbench/team-templates@1";

/** Templates as a JSON file: their content only, no ids or dates. */
export function exportTeamTemplates(templates: readonly TeamTemplateContent[]): string {
  return `${JSON.stringify(
    {
      format: TEAM_TEMPLATE_FORMAT,
      templates: templates.map(({ name, summary, members, leadIndex }) => ({ name, summary, members, leadIndex })),
    },
    null,
    2,
  )}\n`;
}

/**
 * Reads templates from a JSON file: an export of this application, a list of
 * templates, or a single one. Every template is checked; the ones that fail
 * are named with the reason instead of being taken half.
 */
export function parseTeamTemplateImport(text: string): {
  readonly templates: TeamTemplateContent[];
  readonly errors: string[];
} {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { templates: [], errors: ["The file is not JSON."] };
  }
  const list: unknown[] =
    Array.isArray(parsed)
      ? parsed
      : parsed && typeof parsed === "object" && Array.isArray((parsed as { templates?: unknown }).templates)
        ? (parsed as { templates: unknown[] }).templates
        : [parsed];
  const templates: TeamTemplateContent[] = [];
  const errors: string[] = [];
  list.forEach((entry, index) => {
    const result = teamTemplateContentSchema.safeParse(entry);
    if (result.success) {
      templates.push(result.data);
    } else {
      const issue = result.error.issues[0];
      const name =
        entry && typeof entry === "object" && typeof (entry as { name?: unknown }).name === "string"
          ? `"${(entry as { name: string }).name}"`
          : `Template ${index + 1}`;
      errors.push(`${name}: ${issue ? `${issue.path.join(".") || "template"} — ${issue.message}` : "not a template"}`);
    }
  });
  return { templates, errors };
}
