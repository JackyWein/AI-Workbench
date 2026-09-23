import {
  HOOK_WAIT_TIMEOUT_S,
  HookState,
  describeToolInput,
  field,
  oneLine,
  stringField,
  type HookDialect,
  type HookRequest,
} from "@ai-workbench/provider-cli";
import type {
  TerminalAttention,
  TerminalAttentionChoice,
  TerminalAttentionResponse,
} from "@ai-workbench/shared";

/**
 * What an interactive Claude Code run waits on the person for, through the
 * tool's documented hooks (code.claude.com/docs/en/hooks), and answering it
 * from outside the terminal.
 *
 * Measured against Claude Code 2.1.280 before this was built:
 *
 * - `PermissionRequest` fires as Claude Code's own permission dialog appears,
 *   and the dialog stays usable in the terminal while the hook runs.
 * - A hook that answers later, with `decision.behavior` "allow" or "deny",
 *   still settles the dialog: the command runs, or Claude is told no.
 * - Answering in the terminal with Esc ends the waiting hook (SIGTERM);
 *   allowing there does not end it, and the tool goes on to run.
 * - A question (`AskUserQuestion`) arrives as a `PermissionRequest` too, and
 *   is answered with "allow" and the answers in `updatedInput`.
 * - A turn starts with `UserPromptSubmit` and ends with `Stop` (or
 *   `StopFailure` on an API error), and a session that starts or is cleared
 *   reports `SessionStart`. A turn the person interrupts with Esc ends with
 *   no hook at all — not even `idle_prompt` a minute later — but Claude Code
 *   writes "[Request interrupted by user]" into its session transcript.
 *
 * So the permission hook waits for an answer from the application and hands
 * it to Claude Code, while the person can still answer in the terminal as
 * always; whichever comes first counts. The run's other hooks only report,
 * in the background: a request that was settled elsewhere is let go, and
 * whether Claude is working or idle at its prompt follows from them.
 *
 * The mechanics are shared with other tools (`HookState` in the CLI
 * package); this file is what is Claude Code's own.
 */

export const ATTENTION_SOURCE = "Claude Code hooks";

/**
 * How long a permission hook may wait for an answer from the application.
 * Claude Code cancels it after this and simply keeps its own dialog.
 */
export const PERMISSION_HOOK_TIMEOUT_S = HOOK_WAIT_TIMEOUT_S;

/** What Claude is told when the person declines from outside the terminal. */
export const DENY_MESSAGE = "The person declined this from the AI Workbench status island.";

/** The hooks a run is started with; only the permission hook ever waits. */
export const HOOK_EVENTS = [
  "PermissionRequest",
  "PostToolUse",
  "PostToolUseFailure",
  "SessionStart",
  "UserPromptSubmit",
  "Stop",
  "StopFailure",
] as const;
export type HookEvent = (typeof HOOK_EVENTS)[number];

/**
 * The hooks section of a run's settings. The permission hook blocks — that is
 * how its answer reaches Claude Code — and says so in Claude Code's spinner;
 * every other hook runs in the background and never slows the tool down.
 */
export function hookSettings(command: (event: HookEvent) => string): Record<string, unknown> {
  const hooks: Record<string, unknown> = {};
  for (const event of HOOK_EVENTS) {
    const waits = event === "PermissionRequest";
    hooks[event] = [
      {
        matcher: "",
        hooks: [
          {
            type: "command",
            command: command(event),
            ...(waits
              ? {
                  timeout: PERMISSION_HOOK_TIMEOUT_S,
                  statusMessage: "Waiting for an answer here or on the AI Workbench island",
                }
              : { async: true }),
          },
        ],
      },
    ];
  }
  return hooks;
}

/** How Claude Code records a turn the person interrupted, in its transcript. */
const INTERRUPTED = "[Request interrupted by user";

/** A permission request as the application shows it. */
export function attentionOf(
  id: string,
  tool: string,
  input: unknown,
  since: Date,
): TerminalAttention {
  if (tool === "AskUserQuestion") {
    const questions = field(input, "questions");
    const list = Array.isArray(questions) ? questions : [];
    const first: unknown = list[0];
    const question = stringField(first, "question") ?? "Claude has a question";
    const options = field(first, "options");
    const choices = (Array.isArray(options) ? options : []).flatMap(
      (option: unknown, index): TerminalAttentionChoice[] => {
        const label = stringField(option, "label");
        const hint = stringField(option, "description");
        return label
          ? [{ id: String(index), label: oneLine(label, 200), ...(hint ? { hint: oneLine(hint, 200) } : {}) }]
          : [];
      },
    );
    // Only one question with one answer fits the island; anything more is
    // answered in the terminal, where the whole form is.
    const answerable =
      list.length === 1 &&
      field(first, "multiSelect") !== true &&
      choices.length > 0 &&
      choices.length <= 9;
    return {
      id,
      kind: "question",
      tool,
      summary: oneLine(list.length > 1 ? `${question} (+${list.length - 1} more)` : question),
      choices: answerable ? choices : [],
      answerable,
      since,
    };
  }
  return {
    id,
    kind: "permission",
    tool,
    summary: describeToolInput(input),
    choices: [],
    // Leaving plan mode takes the plan itself as its answer, which only the
    // terminal can give.
    answerable: tool !== "ExitPlanMode",
    since,
  };
}

/** True for the transcript record Claude Code writes when a turn is interrupted. */
export function isInterruption(record: unknown): boolean {
  if (stringField(record, "type") !== "user") {
    return false;
  }
  const content = field(record, "message", "content");
  const texts =
    typeof content === "string"
      ? [content]
      : Array.isArray(content)
        ? content.map((part: unknown) => stringField(part, "text") ?? "")
        : [];
  return texts.some((text) => text.startsWith(INTERRUPTED));
}

/** What the permission hook prints: Claude Code's own decision format. */
function answerOf(request: HookRequest, response: TerminalAttentionResponse): string | null {
  const { attention } = request;
  let decision: Record<string, unknown>;
  if ("decision" in response) {
    if (attention.kind !== "permission") {
      return null;
    }
    decision =
      response.decision === "allow"
        ? { behavior: "allow" }
        : { behavior: "deny", message: DENY_MESSAGE };
  } else {
    const choice = attention.choices.find((entry) => entry.id === response.choice);
    const questions = field(request.input, "questions");
    const text = Array.isArray(questions) ? stringField(questions[0], "question") : undefined;
    if (
      attention.kind !== "question" ||
      !choice ||
      !text ||
      typeof request.input !== "object" ||
      request.input === null
    ) {
      return null;
    }
    // Claude Code's documented way to answer a question: the original input,
    // with the chosen label under the question's own text.
    decision = {
      behavior: "allow",
      updatedInput: { ...request.input, answers: { [text]: choice.label } },
    };
  }
  return JSON.stringify({ hookSpecificOutput: { hookEventName: "PermissionRequest", decision } });
}

/** Claude Code's hooks, as the shared hook state reads them. */
export const claudeDialect: HookDialect = {
  waitEvent: "PermissionRequest",
  toolDone: ["PostToolUse", "PostToolUseFailure"],
  turnStart: ["UserPromptSubmit"],
  turnEnd: ["SessionStart", "Stop", "StopFailure"],
  describe: attentionOf,
  answer: answerOf,
  // An interrupted turn fires no hook, but it is written to the transcript.
  endsTurn: isInterruption,
};

/** The state of one Claude Code run, from its hooks. */
export class ClaudeHookState extends HookState {
  constructor(directory: string, options: { readonly alive?: (pid: number) => boolean } = {}) {
    super(directory, claudeDialect, options);
  }
}
