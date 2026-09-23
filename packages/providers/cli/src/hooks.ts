import { existsSync } from "node:fs";
import { mkdir, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  TerminalActivity,
  TerminalAttention,
  TerminalAttentionResponse,
} from "@ai-workbench/shared";
import type { CliInteractiveTelemetry } from "./extensions.js";
import { JsonLinesFollower, field, listDirectory, modifiedAt, poll, readJsonFile, stringField } from "./follow.js";

/**
 * A bridge between a coding tool's own command hooks and the application
 * (spec §99): what an interactive run waits on the person for, whether it is
 * working or idle, and answering a permission from outside its terminal.
 *
 * Several tools share the same hook model — a command per event, the event
 * as JSON on stdin, an answer as JSON on stdout — so the mechanics live here
 * once, and each provider package only describes its tool in a `HookDialect`:
 * which events mean what, and how an answer is written. The mechanism was
 * measured against Claude Code 2.1.280 first (see the Claude package): the
 * tool's own prompt stays usable while a permission hook waits, a late answer
 * still settles it, and answering in the terminal ends or outlasts the hook.
 *
 * Every event is saved atomically as a file of its own — hook input is JSON
 * that may span lines, so one shared log would not do. The waiting hook then
 * waits for an answer file from the application, for a note that the request
 * was settled elsewhere, or for the tool to end it, and prints the answer as
 * is, so no JSON is ever parsed in a shell.
 *
 * Not every tool keeps its own prompt usable while a hook runs: Codex shows
 * no dialog until its permission hook returns. For such a tool the hook only
 * reports, and an answer from outside is the dialog's own key pressed in the
 * tile's terminal — the tool's own path, pressed for the person.
 *
 * The hook command is the same on every run: tools that ask the person to
 * trust new hooks (Codex does) then ask once, not on every start. Where a
 * run's events go is in the environment instead (`HOOK_DIR_ENV`).
 */

/** Names the run's event directory for the bridge; set in the tool's environment. */
export const HOOK_DIR_ENV = "AI_WORKBENCH_HOOK_DIR";

/**
 * How long a waiting hook may wait for an answer from the application. The
 * tool cancels it after this and simply keeps its own dialog.
 */
export const HOOK_WAIT_TIMEOUT_S = 86_400;

/** Checks in the waiting hook; bounds how long an orphaned one can linger. */
const WAIT_STEPS = HOOK_WAIT_TIMEOUT_S * 5;

/**
 * The bridge on macOS and Linux, run with /bin/sh. Arguments: the event's
 * name, and "wait" for the one event that waits. A tool started anywhere
 * else than in the application has no event directory, and the bridge then
 * does nothing at all.
 */
export const POSIX_HOOK_SCRIPT = `dir=$${HOOK_DIR_ENV}
name=$1
mode=$2
[ -n "$dir" ] && [ -d "$dir" ] || exit 0
base="$dir/$name.$$"
if cat > "$base.tmp"; then
  mv -f "$base.tmp" "$base.json"
else
  rm -f "$base.tmp"
  exit 0
fi
[ "$mode" = "wait" ] || exit 0
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
 * The same bridge for Windows, where tools run hook commands through Git Bash
 * or PowerShell and \`powershell -File\` works from both.
 */
export const POWERSHELL_HOOK_SCRIPT = `param([string]$Name, [string]$Mode = 'observe')
$ErrorActionPreference = 'SilentlyContinue'
$Dir = $env:${HOOK_DIR_ENV}
if (-not $Dir -or -not (Test-Path -LiteralPath $Dir)) { exit 0 }
$utf8 = New-Object System.Text.UTF8Encoding $false
[Console]::InputEncoding = $utf8
[Console]::OutputEncoding = $utf8
$json = [Console]::In.ReadToEnd()
$base = Join-Path $Dir "$Name.$PID"
try {
  [IO.File]::WriteAllText("$base.tmp", $json, $utf8)
  Move-Item -LiteralPath "$base.tmp" -Destination "$base.json" -Force
} catch { exit 0 }
if ($Mode -ne 'wait') { exit 0 }
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

/** The shell tools run hook commands with on macOS and Linux. */
export const POSIX_HOOK_SHELL = "/bin/sh";

/** A single-quoted POSIX shell word. */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** A path as a Windows hook command may contain it: forward slashes, quoted. */
function windowsQuoted(path: string): string {
  return `"${path.replace(/\\/g, "/")}"`;
}

export interface HookCommandOptions {
  readonly script: string;
  readonly event: string;
  /** True for the one event whose hook waits for an answer. */
  readonly waits: boolean;
}

/** A hook bridge command for one run and one event, on macOS and Linux. */
export function posixHookCommand(options: HookCommandOptions): string {
  return [
    POSIX_HOOK_SHELL,
    shellQuote(options.script),
    options.event,
    options.waits ? "wait" : "observe",
  ].join(" ");
}

/** A hook bridge command for one run and one event, on Windows. */
export function powershellHookCommand(options: HookCommandOptions): string {
  return [
    "powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File",
    windowsQuoted(options.script),
    windowsQuoted(options.event),
    options.waits ? '"wait"' : '"observe"',
  ].join(" ");
}

/** One run's hook bridge: the script to call and where its events go. */
export interface HookRun {
  readonly script: string;
  readonly directory: string;
  readonly windows: boolean;
}

/** Run folders older than this are removed when a new run starts. */
const HOOK_RUN_TTL_MS = 3 * 24 * 60 * 60 * 1000;

/**
 * Prepares the bridge for one run: the script, always at the same path and
 * with the same content so the hook command never changes, and a fresh
 * folder for the run's events. Null when the shell the bridge needs is
 * missing: no hook is installed rather than one that cannot run.
 */
export async function prepareHookRun(stateDirectory: string, runId: string): Promise<HookRun | null> {
  const windows = process.platform === "win32";
  if (!windows && !existsSync(POSIX_HOOK_SHELL)) {
    return null;
  }
  const script = join(stateDirectory, windows ? "hook-bridge.ps1" : "hook-bridge.sh");
  // With a byte order mark: Windows PowerShell reads a file without one in
  // the legacy code page.
  await writeFile(script, windows ? `\uFEFF${POWERSHELL_HOOK_SCRIPT}` : POSIX_HOOK_SCRIPT, "utf8");
  const root = join(stateDirectory, "hook-runs");
  await mkdir(root, { recursive: true });
  void sweepHookRuns(root, Date.now());
  const directory = join(root, runId);
  await mkdir(directory, { recursive: true });
  return { script, directory, windows };
}

/** The hook command for one event of a prepared run. */
export function hookCommandFor(run: HookRun, event: string, waits: boolean): string {
  return (run.windows ? powershellHookCommand : posixHookCommand)({
    script: run.script,
    event,
    waits,
  });
}

/** Removes the event folders of earlier runs, so they do not pile up. */
async function sweepHookRuns(root: string, now: number): Promise<void> {
  let entries: string[];
  try {
    entries = await readdir(root);
  } catch {
    return;
  }
  await Promise.all(
    entries.map(async (entry) => {
      const path = join(root, entry);
      try {
        if (now - (await stat(path)).mtimeMs > HOOK_RUN_TTL_MS) {
          await rm(path, { force: true, recursive: true });
        }
      } catch {
        // Gone already, or in use.
      }
    }),
  );
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

const MAX_SUMMARY = 300;

/** One line of at most `max` characters. */
export function oneLine(text: string, max = MAX_SUMMARY): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** What a tool call wants, in the tool's own terms: the command, the file. */
export function describeToolInput(input: unknown): string {
  const text =
    stringField(input, "command") ??
    stringField(input, "cmd") ??
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

/** A request as a dialect sees it when writing an answer. */
export interface HookRequest {
  readonly attention: TerminalAttention;
  readonly tool: string;
  readonly input: unknown;
}

/** Somewhere to type into the tool's own terminal. */
export interface TerminalInput {
  write(data: string): void;
}

/**
 * How one tool's hooks speak. Event names are the tool's own; everything a
 * dialect leaves out simply does not happen for that tool.
 */
export interface HookDialect {
  /** The event that reports a permission request; null when none does. */
  readonly permissionEvent: string | null;
  /**
   * How an answer from outside reaches the tool: "hook" — the permission
   * hook waits and prints it; "keys" — the hook only reports, and the answer
   * is the key the tool's own dialog takes, typed into its terminal.
   */
  readonly answerBy: "hook" | "keys";
  /**
   * Events that say the tool waits on the person without taking an answer
   * from a hook — shown, answered only in the terminal. Returns the tool and
   * its input, or null when this event is not such a report.
   */
  observeWaiting?(event: string, body: unknown): { tool: string; input: unknown } | null;
  /** Events after which a tool ran or failed: its request was settled. */
  readonly toolDone: readonly string[];
  /** Events that start a turn: working from here. */
  readonly turnStart: readonly string[];
  /** Events after which the tool is idle at its prompt. */
  readonly turnEnd: readonly string[];
  /** What the application shows for a request. */
  describe(id: string, tool: string, input: unknown, since: Date): TerminalAttention;
  /**
   * The answer: what the waiting hook prints, or the keys to type into the
   * tool's terminal; null when the request cannot take it.
   */
  answer(request: HookRequest, response: TerminalAttentionResponse): string | null;
  /** A transcript record that ends a turn no hook reports, such as an interruption. */
  endsTurn?(record: unknown): boolean;
}

interface OpenRequest extends HookRequest {
  /** How it is answered: its waiting hook, keys in the terminal, or not from here. */
  readonly via: "hook" | "keys" | "none";
  /** Path prefix of the hook's answer and withdrawn files; null when nothing waits. */
  readonly base: string | null;
  /** The waiting hook's process; null when no hook waits. */
  readonly pid: number | null;
  /** The subagent that asked, when it was not the main conversation. */
  readonly agentId: string | undefined;
}

const EVENT_FILE = /^([A-Za-z]+)\.(\d+)\.json$/;

/**
 * A key answer waits this long after the request was reported: the tool
 * draws its dialog a moment after the hook ran (Codex took under a second),
 * and a key typed before that would land in its prompt instead.
 */
export const KEY_ANSWER_SETTLE_MS = 1500;

/**
 * A run's state as its hooks report it: the requests waiting on the person,
 * and whether the tool is working or idle. Built from the hook files as they
 * arrive; the dialect says what each event means.
 */
export class HookState {
  readonly #directory: string;
  readonly #dialect: HookDialect;
  readonly #alive: (pid: number) => boolean;
  #open: OpenRequest[] = [];
  #activity: TerminalActivity | null = null;
  /** The session transcript, read from where it stood when first seen. */
  #transcript: JsonLinesFollower | null = null;

  constructor(
    directory: string,
    dialect: HookDialect,
    options: { readonly alive?: (pid: number) => boolean } = {},
  ) {
    this.#directory = directory;
    this.#dialect = dialect;
    this.#alive = options.alive ?? processAlive;
  }

  /** The oldest request still waiting; null when nothing waits. */
  get current(): TerminalAttention | null {
    return this.#open[0]?.attention ?? null;
  }

  /** Working or idle; null until the tool has said either. */
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
    // A hook that is gone no longer waits: the tool ended it because the
    // person answered in the terminal, or its time ran out.
    for (const request of this.#open.filter(
      (entry) => entry.pid !== null && !this.#alive(entry.pid),
    )) {
      await this.#close(request, false);
    }
    // A turn that ends without a hook: the transcript says so.
    const endsTurn = this.#dialect.endsTurn;
    for (const record of (endsTurn && (await this.#transcript?.readNew())) || []) {
      const at = Date.parse(stringField(record, "timestamp") ?? "");
      const activity = this.#activity;
      if (
        activity?.state === "working" &&
        endsTurn?.(record) &&
        (Number.isNaN(at) || at >= activity.since.getTime())
      ) {
        this.#activity = { state: "idle", since: Number.isNaN(at) ? new Date() : new Date(at) };
      }
    }
  }

  /**
   * Hands an answer to the tool: to its waiting hook, or as its own key in its
   * terminal. False when the request no longer waits or cannot take it.
   */
  async respond(
    attentionId: string,
    response: TerminalAttentionResponse,
    terminal?: TerminalInput,
  ): Promise<boolean> {
    const request = this.#open.find((entry) => entry.attention.id === attentionId);
    if (!request?.attention.answerable || request.via === "none") {
      return false;
    }
    const output = this.#dialect.answer(request, response);
    if (output === null) {
      return false;
    }
    if (request.via === "keys") {
      if (!terminal) {
        return false;
      }
      const wait = request.attention.since.getTime() + KEY_ANSWER_SETTLE_MS - Date.now();
      if (wait > 0) {
        await new Promise((resolve) => setTimeout(resolve, wait));
      }
      // Answered in the terminal meanwhile: nothing left to press.
      await this.read();
      if (!this.#open.includes(request)) {
        return false;
      }
      terminal.write(output);
      this.#open = this.#open.filter((entry) => entry !== request);
      return true;
    }
    if (request.pid === null || request.base === null) {
      return false;
    }
    if (!this.#alive(request.pid)) {
      await this.#close(request, false);
      return false;
    }
    // Renamed into place, so the hook never prints half an answer.
    await writeFile(`${request.base}.answer.tmp`, output, "utf8");
    await rename(`${request.base}.answer.tmp`, `${request.base}.answer`);
    this.#open = this.#open.filter((entry) => entry !== request);
    return true;
  }

  /** Lets every waiting hook go; the tool's own dialogs stay. */
  async withdrawAll(): Promise<void> {
    for (const request of [...this.#open]) {
      await this.#close(request, true);
    }
  }

  async #apply(event: string, pid: number, body: unknown, at: number): Promise<void> {
    const dialect = this.#dialect;
    const agentId = stringField(body, "agent_id");
    if (dialect.endsTurn) {
      await this.#follow(stringField(body, "transcript_path"));
    }
    if (event === dialect.permissionEvent) {
      const tool = stringField(body, "tool_name") ?? "a tool";
      const input = field(body, "tool_input");
      const hookWaits = dialect.answerBy === "hook";
      this.#open.push({
        attention: dialect.describe(`${pid}-${Math.round(at)}`, tool, input, new Date(at)),
        via: dialect.answerBy,
        base: hookWaits ? join(this.#directory, `${event}.${pid}`) : null,
        pid: hookWaits ? pid : null,
        tool,
        input,
        agentId,
      });
      return;
    }
    const observed = dialect.observeWaiting?.(event, body);
    if (observed) {
      const attention = dialect.describe(
        `${pid}-${Math.round(at)}`,
        observed.tool,
        observed.input,
        new Date(at),
      );
      this.#open.push({
        attention: { ...attention, answerable: false, choices: [] },
        via: "none",
        base: null,
        pid: null,
        tool: observed.tool,
        input: observed.input,
        agentId,
      });
      return;
    }
    if (dialect.toolDone.includes(event)) {
      // The tool ran, so its request was allowed somewhere: in the terminal.
      const tool = stringField(body, "tool_name");
      const request = this.#open.find((entry) => entry.tool === tool && entry.agentId === agentId);
      if (request) {
        await this.#close(request, true);
      }
      return;
    }
    const starts = dialect.turnStart.includes(event);
    if (starts || dialect.turnEnd.includes(event)) {
      // A subagent's turn and requests are its own; this is the session's.
      if (agentId !== undefined) {
        return;
      }
      // A new prompt, or the end of the turn: the conversation waits on
      // nothing it asked before.
      for (const request of this.#open.filter((entry) => entry.agentId === undefined)) {
        await this.#close(request, true);
      }
      this.#activity = { state: starts ? "working" : "idle", since: new Date(at) };
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
    if (request.base === null || request.pid === null) {
      return;
    }
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

/** How often the hooks' reports are checked; someone may be waiting. */
const HOOK_POLL_MS = 250;

/**
 * The attention, activity and answer parts of a run's telemetry, read from
 * its hook state. One reader serves both watchers; stopping the last lets
 * every waiting hook go, and the tool's own prompts stay.
 */
export function hookTelemetry(
  state: HookState,
): Required<Pick<CliInteractiveTelemetry, "watchAttention" | "watchActivity" | "respond">> {
  const listeners = {
    attention: null as ((attention: TerminalAttention | null) => void) | null,
    activity: null as ((activity: TerminalActivity | null) => void) | null,
  };
  let reading: (() => void) | null = null;
  let lastAttention: string | null = null;
  let lastActivity: string | null = null;
  const startReading = (): void => {
    reading ??= poll(async () => {
      await state.read();
      const attention = state.current;
      const attentionSignature = attention ? JSON.stringify(attention) : null;
      if (attentionSignature !== lastAttention) {
        lastAttention = attentionSignature;
        listeners.attention?.(attention);
      }
      const activity = state.activity;
      const activitySignature = activity ? JSON.stringify(activity) : null;
      if (activitySignature !== lastActivity) {
        lastActivity = activitySignature;
        listeners.activity?.(activity);
      }
    }, HOOK_POLL_MS);
  };
  const stopReading = (): void => {
    if (listeners.attention || listeners.activity || !reading) {
      return;
    }
    reading();
    reading = null;
    void state.withdrawAll().catch(() => undefined);
  };
  return {
    watchAttention: (onAttention) => {
      listeners.attention = onAttention;
      lastAttention = null;
      startReading();
      return () => {
        listeners.attention = null;
        stopReading();
      };
    },
    watchActivity: (onActivity) => {
      listeners.activity = onActivity;
      lastActivity = null;
      startReading();
      return () => {
        listeners.activity = null;
        stopReading();
      };
    },
    respond: (attentionId, response, terminal) => state.respond(attentionId, response, terminal),
  };
}
