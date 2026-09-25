import { teamTemplateContentSchema, type TeamTemplateDraft } from "@ai-workbench/shared";
import { askOnce } from "./one-turn.js";
import type { ProviderManager } from "./provider-manager.js";

export class TeamTemplateDraftError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TeamTemplateDraftError";
  }
}

export interface DraftTeamTemplateRequest {
  readonly providerId: string;
  readonly modelId?: string | undefined;
  readonly reasoningEffort?: string | undefined;
  /** What the team should be, in the person's words. */
  readonly request: string;
}

/** What the model is asked for: one JSON template in a fixed shape. */
export function teamTemplatePrompt(request: string): string {
  return [
    "Design a team template for AI coding agents that work on a goal together.",
    "A lead plans the work and hands out tasks; every other member works in its role.",
    "",
    "What the team should be:",
    request.trim(),
    "",
    "Answer with only one JSON object and nothing before or after it, in exactly this shape:",
    '{"name": "<a short team name>", "summary": "<one sentence>", "leadIndex": 0, "members": [{"name": "<a short name>", "role": "<one line the rest of the team sees>", "instructions": "<how this member works, in two to five short paragraphs>"}]}',
    "",
    "Use two to six members, the lead first. The instructions say how to work in the role — never which tool, product or model to use.",
    "Do not use any tools, and do not create or change files.",
  ].join("\n");
}

/**
 * Reads a drafted template out of an answer — bare, fenced, or with a
 * sentence around it — and checks it. A draft that does not hold up is
 * refused with the reason, never half-taken. Tools and models are the
 * person's choice, so a draft never carries any.
 */
export function parseTeamTemplateDraft(answer: string): TeamTemplateDraft {
  const fenced = /```(?:json)?\s*\n([\s\S]*?)\n```/.exec(answer);
  let text = fenced?.[1] ?? answer;
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) {
    throw new TeamTemplateDraftError("The answer held no template.");
  }
  text = text.slice(start, end + 1);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new TeamTemplateDraftError("The template in the answer was not valid JSON.");
  }
  const checked = teamTemplateContentSchema.safeParse(parsed);
  if (!checked.success) {
    const issue = checked.error.issues[0];
    throw new TeamTemplateDraftError(
      `The drafted template does not hold up: ${issue ? `${issue.path.join(".") || "template"} — ${issue.message}` : "unknown reason"}.`,
    );
  }
  return {
    ...checked.data,
    members: checked.data.members.map(({ name, role, instructions }) => ({ name, role, instructions })),
  };
}

/**
 * Has one of the person's own tools draft a team template. Nothing is stored:
 * the draft goes back to the person, who reads it and saves it or not.
 */
export async function draftTeamTemplate(
  providers: ProviderManager,
  request: DraftTeamTemplateRequest,
  scratchDirectory: string,
): Promise<TeamTemplateDraft> {
  const { text, failure, modelId } = await askOnce(
    providers,
    {
      providerId: request.providerId,
      modelId: request.modelId,
      reasoningEffort: request.reasoningEffort,
      prompt: teamTemplatePrompt(request.request),
      timeoutMs: 4 * 60_000,
    },
    scratchDirectory,
  );
  if (text.trim() === "") {
    throw new TeamTemplateDraftError(failure ?? "The provider did not answer with a template.");
  }
  const draft = parseTeamTemplateDraft(text);
  return modelId ? { ...draft, modelId } : draft;
}
