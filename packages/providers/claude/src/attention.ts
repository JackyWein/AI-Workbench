import { rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  JsonLinesFollower,
  field,
  listDirectory,
  modifiedAt,
  readJsonFile,
  stringField,
} from "@ai-workbench/provider-cli";
import type {
  TerminalActivity,
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
 */

export const ATTENTION_SOURCE = "Claude Code hooks";

/**
 * How long a permission hook may wait for an answer from the application.
 * Claude Code cancels it after this and simply keeps its own dialog.
 */
export const PERMISSION_HOOK_TIMEOUT_S = 86_400;

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

/** Checks in the waiting hook; bounds how long an orphaned one can linger. */
const WAIT_STEPS = PERMISSION_HOOK_TIMEOUT_S * 5;

/**
 * The hook bridge on macOS and Linux, run with /bin/sh like the status line
 * bridge. Arguments: this run's event directory and the event's name.
 *
 * Every event is saved atomically as a file of its own — hook input is JSON
 * that may span lines, so one shared log would not do. A permission request
 * then waits for an answer file from the application, for a note that it was
 * settled elsewhere, or for Claude Code to end it; it prints the answer as is,
 * so no JSON is ever parsed in sh.
 */
export const POSIX_HOOK_SCRIPT = `dir=$1
name=$2
base="$dir/$name.$$"
if cat > "$base.tmp"; then
  mv -f "$base.tmp" "$base.json"
else
  rm -f "$base.tmp"
  exit 0
fi
[ "$name" = "PermissionRequest" ] || exit 0
parent=$PPID
n=0
while [ "$n" -lt ${WAIT_STEPS} ]; do
  if [ -f "$base.answer" ]; then
    cat "$base.answer"
    rm -f "$base.answer"
    exit 0
  fi
  if [ -f "$base.withdrawn" ]; then
    rm -f "$base.withdrawn"
    exit 0
  fi
  kill -0 "$parent" 2>/dev/null || exit 0
  sleep 0.2 2>/dev/null || sleep 1
  n=$((n + 1))
done
exit 0
`;

/**
 * The same bridge for Windows, where Claude Code runs hook commands through
 * Git Bash or PowerShell and \`powershell -File\` works from both.
 */
export const POWERSHELL_HOOK_SCRIPT = `param([string]$Dir, [string]$Name)
$ErrorActionPreference = 'SilentlyContinue'
$utf8 = New-Object System.Text.UTF8Encoding $false
[Console]::InputEncoding = $utf8
[Console]::OutputEncoding = $utf8
$json = [Console]::In.ReadToEnd()
$base = Join-Path $Dir "$Name.$PID"
try {
  [IO.File]::WriteAllText("$base.tmp", $json, $utf8)
  Move-Item -LiteralPath "$base.tmp" -Destination "$base.json" -Force
} catch { exit 0 }
if ($Name -ne 'PermissionRequest') { exit 0 }
for ($i = 0; $i -lt ${WAIT_STEPS}; $i++) {
  if (Test-Path -LiteralPath "$base.answer") {
    [Console]::Out.Write([IO.File]::ReadAllText("$base.answer", $utf8))
    Remove-Item -LiteralPath "$base.answer" -Force
    exit 0
  }
  if (Test-Path -LiteralPath "$base.withdrawn") {
    Remove-Item -LiteralPath "$base.withdrawn" -Force
    exit 0
  }
  Start-Sleep -Milliseconds 200
}
exit 0
`;

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

/** Whether a process still runs. Signal 0 checks without touching it. */
export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // It exists but belongs to someone else: still alive.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

interface OpenRequest {
  readonly attention: TerminalAttention;
  /** Path prefix of the hook's answer and withdrawn files. */
  readonly base: string;
  /** The waiting hook's process. */
  readonly pid: number;
  readonly tool: string;
  readonly input: unknown;
  /** The subagent that asked, when it was not the main conversation. */
  readonly agentId: string | undefined;
}

const EVENT_FILE = /^([A-Za-z]+)\.(\d+)\.json$/;
/** How Claude Code records a turn the person interrupted, in its transcript. */
const INTERRUPTED = "[Request interrupted by user";
const MAX_SUMMARY = 300;

/** One line of at most `max` characters. */
function oneLine(text: string, max = MAX_SUMMARY): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** What a tool call wants, in the tool's own terms: the command, the file. */
export function describeToolInput(input: unknown): string {
  const text =
    stringField(input, "command") ??
    stringField(input, "file_path") ??
    stringField(input, "notebook_path") ??
    stringField(input, "path") ??
    stringField(input, "url") ??
    stringField(input, "query") ??
    stringField(input, "pattern") ??
    stringField(input, "description") ??
    "";
  return oneLine(text);
}

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

/**
 * The run's state as its hooks report it: the requests waiting on the person,
 * and whether Claude is working or idle. Built from the hook files as they
 * arrive; only this class knows the file layout and Claude Code's answer
 * format.
 */
export class ClaudeHookState {
  readonly #directory: string;
  readonly #alive: (pid: number) => boolean;
  #open: OpenRequest[] = [];
  #activity: TerminalActivity | null = null;
  /** The session transcript, read from where it stood when first seen. */
  #transcript: JsonLinesFollower | null = null;

  constructor(directory: string, options: { readonly alive?: (pid: number) => boolean } = {}) {
    this.#directory = directory;
    this.#alive = options.alive ?? processAlive;
  }

  /** The oldest request still waiting; null when nothing waits. */
  get current(): TerminalAttention | null {
    return this.#open[0]?.attention ?? null;
  }

  /** Working or idle; null until Claude Code has said either. */
  get activity(): TerminalActivity | null {
    return this.#activity;
  }

  /** Takes in what the hooks reported since the last call. */
  async read(): Promise<void> {
    const files = (await listDirectory(this.#directory)).filter((name) => EVENT_FILE.test(name));
    const stamped = await Promise.all(
      files.map(async (name) => ({ name, at: await modifiedAt(join(this.#directory, name)) })),
    );
    // In the order they were written; a hook's file appears at once.
    const ordered = stamped
      .filter((entry): entry is { name: string; at: number } => entry.at !== null)
      .sort((left, right) => left.at - right.at || left.name.localeCompare(right.name));
    for (const { name, at } of ordered) {
      const path = join(this.#directory, name);
      const match = EVENT_FILE.exec(name);
      const body = await readJsonFile(path);
      await rm(path, { force: true });
      if (!match?.[1] || !match[2] || body === null) {
        continue;
      }
      await this.#apply(match[1], Number(match[2]), body, at);
    }
    // A hook that is gone no longer waits: Claude Code ended it because the
    // person answered in the terminal, or its time ran out.
    for (const request of this.#open.filter((entry) => !this.#alive(entry.pid))) {
      await this.#close(request, false);
    }
    // An interrupted turn ends without a hook; the transcript says so.
    for (const record of (await this.#transcript?.readNew()) ?? []) {
      const at = Date.parse(stringField(record, "timestamp") ?? "");
      const activity = this.#activity;
      if (
        activity?.state === "working" &&
        isInterruption(record) &&
        (Number.isNaN(at) || at >= activity.since.getTime())
      ) {
        this.#activity = { state: "idle", since: Number.isNaN(at) ? new Date() : new Date(at) };
      }
    }
  }

  /**
   * Hands an answer to the waiting hook, which passes it to Claude Code.
   * False when the request no longer waits or cannot take this answer.
   */
  async respond(attentionId: string, response: TerminalAttentionResponse): Promise<boolean> {
    const request = this.#open.find((entry) => entry.attention.id === attentionId);
    if (!request?.attention.answerable) {
      return false;
    }
    if (!this.#alive(request.pid)) {
      await this.#close(request, false);
      return false;
    }
    const decision = this.#decision(request, response);
    if (!decision) {
      return false;
    }
    const output = JSON.stringify({
      hookSpecificOutput: { hookEventName: "PermissionRequest", decision },
    });
    // Renamed into place, so the hook never prints half an answer.
    await writeFile(`${request.base}.answer.tmp`, output, "utf8");
    await rename(`${request.base}.answer.tmp`, `${request.base}.answer`);
    this.#open = this.#open.filter((entry) => entry !== request);
    return true;
  }

  /** Lets every waiting hook go; Claude Code's own dialogs stay. */
  async withdrawAll(): Promise<void> {
    for (const request of [...this.#open]) {
      await this.#close(request, true);
    }
  }

  #decision(request: OpenRequest, response: TerminalAttentionResponse): Record<string, unknown> | null {
    const { attention } = request;
    if ("decision" in response) {
      if (attention.kind !== "permission") {
        return null;
      }
      return response.decision === "allow"
        ? { behavior: "allow" }
        : { behavior: "deny", message: DENY_MESSAGE };
    }
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
    return {
      behavior: "allow",
      updatedInput: { ...request.input, answers: { [text]: choice.label } },
    };
  }

  async #apply(event: string, pid: number, body: unknown, at: number): Promise<void> {
    const agentId = stringField(body, "agent_id");
    await this.#follow(stringField(body, "transcript_path"));
    switch (event) {
      case "PermissionRequest": {
        const tool = stringField(body, "tool_name") ?? "a tool";
        const input = field(body, "tool_input");
        this.#open.push({
          attention: attentionOf(`${pid}-${Math.round(at)}`, tool, input, new Date(at)),
          base: join(this.#directory, `PermissionRequest.${pid}`),
          pid,
          tool,
          input,
          agentId,
        });
        return;
      }
      case "PostToolUse":
      case "PostToolUseFailure": {
        // The tool ran, so its request was allowed somewhere: in the terminal.
        const tool = stringField(body, "tool_name");
        const request = this.#open.find((entry) => entry.tool === tool && entry.agentId === agentId);
        if (request) {
          await this.#close(request, true);
        }
        return;
      }
      case "SessionStart":
      case "UserPromptSubmit":
      case "Stop":
      case "StopFailure": {
        // A subagent's turn and requests are its own; this is the session's.
        if (agentId !== undefined) {
          return;
        }
        // A new prompt, or the end of the turn: the conversation waits on
        // nothing it asked before.
        for (const request of this.#open.filter((entry) => entry.agentId === undefined)) {
          await this.#close(request, true);
        }
        this.#activity = {
          state: event === "UserPromptSubmit" ? "working" : "idle",
          since: new Date(at),
        };
        return;
      }
      default:
        return;
    }
  }

  /** Starts reading a transcript from where it stands now; earlier turns are over. */
  async #follow(path: string | undefined): Promise<void> {
    if (!path || this.#transcript?.path === path) {
      return;
    }
    const follower = new JsonLinesFollower(path);
    for (let chunk = 0; chunk < 64 && (await follower.readNew()).length > 0; chunk += 1) {
      // Skipping what is already written.
    }
    this.#transcript = follower;
  }

  async #close(request: OpenRequest, withdraw: boolean): Promise<void> {
    this.#open = this.#open.filter((entry) => entry !== request);
    try {
      if (withdraw && this.#alive(request.pid)) {
        await writeFile(`${request.base}.withdrawn`, "", "utf8");
      } else {
        await rm(`${request.base}.withdrawn`, { force: true });
        await rm(`${request.base}.answer`, { force: true });
      }
    } catch {
      // The directory went with the run; nothing is left to let go.
    }
  }
}
