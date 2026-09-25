import { askOnce } from "./one-turn.js";
import type { ProviderManager } from "./provider-manager.js";

/** Most of the staged diff a suggestion is written from. */
const DIFF_LIMIT = 60_000;

/** What the model is asked: a commit message for the staged diff, and nothing around it. */
export function commitMessagePrompt(diff: string): string {
  const shown = diff.length > DIFF_LIMIT ? `${diff.slice(0, DIFF_LIMIT)}\n… (the rest of the diff is left out)` : diff;
  return [
    "Write a git commit message for the staged changes below.",
    "",
    "The first line says what the change does, in the imperative, in at most 72 characters.",
    "If the why is not obvious, add a blank line and a short body. Do not invent anything the diff does not show.",
    "Answer with only the message, with no code fence and nothing before or after it.",
    "Do not use any tools, and do not create or change files.",
    "",
    "```diff",
    shown,
    "```",
  ].join("\n");
}

/** The message from an answer that may have wrapped it in a fence or a label. */
export function parseCommitMessage(answer: string): string {
  let text = answer.trim();
  const fenced = /```[a-z]*\s*\n([\s\S]*?)\n```/.exec(text);
  if (fenced?.[1]) {
    text = fenced[1].trim();
  }
  text = text.replace(/^(?:commit message|message)\s*:\s*/i, "");
  return text
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .trim();
}

/**
 * Has the session's own tool and model suggest a commit message for what is
 * staged. The person reads and edits it before anything is committed.
 */
export async function suggestCommitMessage(
  providers: ProviderManager,
  choice: { readonly providerId: string; readonly modelId?: string | undefined; readonly reasoningEffort?: string | undefined },
  diff: string,
  scratchDirectory: string,
): Promise<string> {
  if (diff.trim() === "") {
    throw new Error("Stage the changes to commit first.");
  }
  const { text, failure } = await askOnce(
    providers,
    { ...choice, prompt: commitMessagePrompt(diff), timeoutMs: 2 * 60_000 },
    scratchDirectory,
  );
  const message = parseCommitMessage(text);
  if (!message) {
    throw new Error(failure ?? "The model did not suggest a message.");
  }
  return message;
}
