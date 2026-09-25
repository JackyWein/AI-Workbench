import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import type { ProviderEvent } from "@ai-workbench/shared";
import { createId } from "./ids.js";
import type { ProviderManager } from "./provider-manager.js";

/** A skill as a provider drafted it, for the person to read before saving. */
export interface SkillDraft {
  readonly name: string;
  readonly description: string;
  readonly instructions: string;
  /** The model that wrote it, when the tool said or one was chosen. */
  readonly modelId?: string;
}

export interface DraftSkillRequest {
  readonly providerId: string;
  readonly modelId?: string;
  readonly reasoningEffort?: string;
  /** What the skill should do, in the person's words. */
  readonly request: string;
}

/** How long a draft may take before it is given up. */
const DRAFT_TIMEOUT_MS = 4 * 60_000;

export class SkillDraftError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SkillDraftError";
  }
}

/**
 * Has one of the person's own tools write a skill: a single turn in an empty
 * folder of the application's, read-only, answered as a SKILL.md. Nothing is
 * saved here — the draft goes back to the person, who edits and saves it.
 */
export async function draftSkill(
  providers: ProviderManager,
  request: DraftSkillRequest,
  scratchDirectory: string,
): Promise<SkillDraft> {
  const adapter = providers.get(request.providerId);
  if (!adapter) {
    throw new SkillDraftError("That provider is not available.");
  }
  const sessionId = createId("draft");
  const folder = join(scratchDirectory, sessionId);
  await mkdir(folder, { recursive: true });
  const info = await adapter.createSession({
    sessionId,
    workingDirectory: folder,
    ...(request.modelId ? { modelId: request.modelId } : {}),
    ...(request.reasoningEffort ? { reasoningEffort: request.reasoningEffort } : {}),
    // Writing a skill needs no tool of the agent's; it only answers.
    permissionMode: "readOnly",
  });
  const modelId = info.modelId ?? request.modelId;
  const handle = {
    sessionId,
    providerSessionId: info.providerSessionId,
    ...(modelId ? { modelId } : {}),
    ...(request.reasoningEffort ? { reasoningEffort: request.reasoningEffort } : {}),
    permissionMode: "readOnly" as const,
  };
  let text = "";
  let failure: string | null = null;
  const timer = setTimeout(() => void adapter.cancel(handle).catch(() => undefined), DRAFT_TIMEOUT_MS);
  try {
    for await (const event of adapter.sendMessage(handle, { text: draftPrompt(request.request) })) {
      const typed = event as ProviderEvent;
      if (typed.type === "text_delta") {
        text += typed.text;
      } else if (typed.type === "error") {
        failure = typed.error.message;
      }
    }
  } finally {
    clearTimeout(timer);
    await adapter.destroySession(handle).catch(() => undefined);
    await rm(folder, { recursive: true, force: true }).catch(() => undefined);
  }
  if (text.trim() === "") {
    throw new SkillDraftError(failure ?? "The provider did not answer with a skill.");
  }
  const draft = parseDraft(text, request.request);
  return modelId ? { ...draft, modelId } : draft;
}

/** What the provider is asked for: a SKILL.md and nothing around it. */
export function draftPrompt(request: string): string {
  return [
    "Write a skill for an AI coding agent. A skill is a short, reusable instruction file",
    "(like a SKILL.md) that the agent follows whenever it applies.",
    "",
    "What the skill should do:",
    request.trim(),
    "",
    "Answer with only the skill, in exactly this form, and nothing before or after it:",
    "---",
    "name: <a short name, a few words>",
    "description: <one sentence: what it does and when to use it>",
    "---",
    "<the instructions in Markdown: what to do, step by step, with concrete rules>",
    "",
    "Do not use any tools, and do not create or change files.",
  ].join("\n");
}

/**
 * Reads the answer as a SKILL.md. A provider that wrapped it in a code
 * fence, or wrote a sentence before it, still yields the skill; one that
 * ignored the form yields its whole answer as the instructions.
 */
export function parseDraft(answer: string, request: string): SkillDraft {
  let text = answer.trim();
  const fenced = /```(?:markdown|md)?\s*\n([\s\S]*?)\n```/.exec(text);
  if (fenced?.[1] && fenced[1].includes("---")) {
    text = fenced[1].trim();
  }
  const start = text.indexOf("---");
  if (start !== -1) {
    const end = text.indexOf("\n---", start + 3);
    if (end !== -1) {
      const header = text.slice(start + 3, end);
      const attributes: Record<string, string> = {};
      for (const line of header.split("\n")) {
        const match = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line.trim());
        if (match?.[1]) {
          attributes[match[1].toLowerCase()] = (match[2] ?? "").trim().replace(/^(["'])(.*)\1$/, "$2");
        }
      }
      const instructions = text.slice(end + 4).trim();
      if (instructions) {
        return {
          name: (attributes["name"] ?? fallbackName(request)).slice(0, 200),
          description: (attributes["description"] ?? "").slice(0, 2000),
          instructions,
        };
      }
    }
  }
  return { name: fallbackName(request), description: "", instructions: text };
}

function fallbackName(request: string): string {
  const words = request.replace(/\s+/g, " ").trim().split(" ").slice(0, 6).join(" ");
  return words.length > 0 ? words.charAt(0).toUpperCase() + words.slice(1) : "New skill";
}
