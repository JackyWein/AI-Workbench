import { existsSync } from "node:fs";
import { mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  JsonLinesFollower,
  field,
  modifiedAt,
  numberField,
  poll,
  POSIX_HOOK_SCRIPT,
  POWERSHELL_HOOK_SCRIPT,
  hookTelemetry,
  posixHookCommand,
  powershellHookCommand,
  readJsonFile,
  stringField,
  type CliExtensionContext,
  type CliInteractiveRun,
  type CliInteractiveTelemetry,
} from "@ai-workbench/provider-cli";
import type { TerminalMetrics, TerminalTokens, UsageLimit } from "@ai-workbench/shared";
import { ClaudeHookState, hookSettings } from "./attention.js";

/**
 * Follows an interactive Claude Code run through the tool's documented status
 * line hook (code.claude.com/docs/en/statusline).
 *
 * Claude Code hands the status line command a JSON description of the session
 * — duration, cost, context window and the account's 5-hour and weekly
 * limits — every time something changes. The run is started with a settings
 * file whose status line is a small bridge: it saves that JSON where the
 * application can read it, then runs the person's own status line command
 * with the same input and prints what it prints. The person keeps the status
 * line they chose; nothing is read off the screen.
 *
 * Token totals come from the session transcript the same JSON points to: one
 * record per model response, each with the usage the API returned.
 */

export const STATUS_LINE_SOURCE = "Claude Code status line";

/** How often the bridge's output is checked for a new report. */
const POLL_MS = 1000;
/** Run files older than this are removed when a new run starts. */
const RUN_FILE_TTL_MS = 3 * 24 * 60 * 60 * 1000;

/**
 * The bridge. PowerShell ships with every supported Windows, and Claude Code
 * runs status line commands through Git Bash or PowerShell — `powershell
 * -File` works from both. Arguments: output file, a script holding the
 * person's own command ("none" when they have none) and the shell to run it
 * with ("none" for PowerShell). The command travels as a file because Windows
 * PowerShell mangles quotes inside native arguments, and "none" stands for
 * absent because a bare "-" reads as a parameter name to PowerShell.
 */
export const BRIDGE_SCRIPT = `param([string]$Out, [string]$Chain = 'none', [string]$Shell = 'none')
$ErrorActionPreference = 'SilentlyContinue'
$utf8 = New-Object System.Text.UTF8Encoding $false
[Console]::InputEncoding = $utf8
[Console]::OutputEncoding = $utf8
$OutputEncoding = $utf8
$json = [Console]::In.ReadToEnd()
try {
  $tmp = "$Out.$PID.tmp"
  [IO.File]::WriteAllText($tmp, $json, $utf8)
  Move-Item -LiteralPath $tmp -Destination $Out -Force
} catch {}
if ($Chain -ne 'none') {
  if ($Shell -ne 'none') {
    & $Shell $Chain
  } else {
    powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $Chain
  }
  exit 0
}
try { $d = $json | ConvertFrom-Json } catch { exit 0 }
$dot = ' ' + [char]0x00B7 + ' '
$parts = @()
if ($d.model.display_name) { $parts += [string]$d.model.display_name }
if ($null -ne $d.context_window.used_percentage) { $parts += ('{0}% context' -f [math]::Round([double]$d.context_window.used_percentage)) }
if ($null -ne $d.rate_limits.five_hour.used_percentage) { $parts += ('5h {0}%' -f [math]::Round([double]$d.rate_limits.five_hour.used_percentage)) }
if ($null -ne $d.rate_limits.seven_day.used_percentage) { $parts += ('week {0}%' -f [math]::Round([double]$d.rate_limits.seven_day.used_percentage)) }
[Console]::Out.Write(($parts -join $dot))
`;

/**
 * The bridge on macOS and Linux, where there is no PowerShell to lean on.
 * Claude Code runs status line commands through /bin/sh there, so the bridge
 * is a plain POSIX script. Arguments: output file, and a script holding the
 * person's own command ("none" when they have none).
 *
 * It saves the report atomically and hands the same input on to the person's
 * own status line. With none configured it prints nothing — exactly what
 * Claude Code shows without a status line — rather than parsing JSON in sh,
 * which would be guesswork without a JSON tool that cannot be assumed.
 */
export const POSIX_BRIDGE_SCRIPT = `out=$1
chain=$2
tmp="$out.$$.tmp"
if cat > "$tmp"; then
  mv -f "$tmp" "$out"
else
  rm -f "$tmp"
fi
if [ "$chain" != "none" ]; then
  exec /bin/sh "$chain"
fi
`;

/** The shell Claude Code itself runs status line commands with on macOS and Linux. */
const POSIX_SHELL = "/bin/sh";

/** The person's own status line, as their settings define it. */
export interface UserStatusLine {
  readonly command: string;
  readonly padding?: number;
}

/**
 * The status line Claude Code would have used for this directory: local
 * project settings win over shared project settings, which win over the
 * user's own (the tool's documented precedence).
 */
export async function findUserStatusLine(
  workingDirectory: string,
  configHome: string,
): Promise<UserStatusLine | null> {
  const candidates = [
    join(workingDirectory, ".claude", "settings.local.json"),
    join(workingDirectory, ".claude", "settings.json"),
    join(configHome, "settings.json"),
  ];
  for (const file of candidates) {
    const settings = await readJsonFile(file);
    const statusLine = field(settings, "statusLine");
    if (statusLine === undefined) {
      continue;
    }
    const command = stringField(statusLine, "command");
    if (stringField(statusLine, "type") !== "command" || !command?.trim()) {
      // A status line switched off here is switched off; do not look further.
      return null;
    }
    const padding = numberField(statusLine, "padding");
    return { command, ...(padding === undefined ? {} : { padding }) };
  }
  return null;
}

/** Git Bash, where Claude Code itself would find it; null when absent. */
export function findGitBash(env: Readonly<Record<string, string | undefined>>): string | null {
  const configured = env["CLAUDE_CODE_GIT_BASH_PATH"];
  const candidates = [
    configured,
    env["ProgramFiles"] && join(env["ProgramFiles"], "Git", "bin", "bash.exe"),
    env["ProgramFiles(x86)"] && join(env["ProgramFiles(x86)"], "Git", "bin", "bash.exe"),
    env["LOCALAPPDATA"] && join(env["LOCALAPPDATA"], "Programs", "Git", "bin", "bash.exe"),
  ];
  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

/** A single-quoted POSIX shell word. */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** A path as a status line command may contain it: forward slashes, quoted. */
function quoted(path: string): string {
  return `"${path.replace(/\\/g, "/")}"`;
}

/** The bridge as a status line command for one run. */
export function bridgeCommand(options: {
  readonly script: string;
  readonly output: string;
  /** Script file holding the person's own command, when they have one. */
  readonly chain: string | null;
  readonly shell: string | null;
}): string {
  return [
    "powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File",
    quoted(options.script),
    quoted(options.output),
    options.chain ? quoted(options.chain) : '"none"',
    options.chain && options.shell ? quoted(options.shell) : '"none"',
  ].join(" ");
}

/** The POSIX bridge as a status line command for one run. */
export function posixBridgeCommand(options: {
  readonly script: string;
  readonly output: string;
  /** Script file holding the person's own command, when they have one. */
  readonly chain: string | null;
}): string {
  return [
    POSIX_SHELL,
    shellQuote(options.script),
    shellQuote(options.output),
    options.chain ? shellQuote(options.chain) : "none",
  ].join(" ");
}

/**
 * Writes the person's status line command where the bridge can run it: a
 * shell script for Git Bash, which is what Claude Code itself would use, or a
 * PowerShell script when there is no Git Bash. The script reads the report
 * the bridge just saved as its input, byte for byte: piping it through
 * PowerShell would add a line ending Claude Code itself never sends.
 */
export async function writeChainScript(
  directory: string,
  runId: string,
  statusLine: UserStatusLine,
  shell: string | null,
  report: string,
): Promise<string> {
  const path = join(directory, `${runId}.statusline.${shell ? "sh" : "ps1"}`);
  const body = shell
    ? `exec < ${shellQuote(report.replace(/\\/g, "/"))}\n${statusLine.command}\n`
    : `\uFEFF[IO.File]::ReadAllText('${report.replace(/'/g, "''")}') | ${statusLine.command}\n`;
  await writeFile(path, body, "utf8");
  return path;
}

/** The status line's 5-hour and weekly windows as usage limits. */
function limitsOf(report: unknown): UsageLimit[] {
  const windows = [
    { key: "five_hour", id: "five_hour", label: "5-hour window", minutes: 300 },
    { key: "seven_day", id: "seven_day", label: "Weekly", minutes: 10_080 },
  ] as const;
  const limits: UsageLimit[] = [];
  for (const window of windows) {
    const percent = numberField(report, "rate_limits", window.key, "used_percentage");
    if (percent === undefined) {
      continue;
    }
    const used = Math.round(Math.max(0, Math.min(100, percent)));
    const resetsAt = numberField(report, "rate_limits", window.key, "resets_at");
    limits.push({
      id: window.id,
      label: window.label,
      used,
      remaining: 100 - used,
      total: 100,
      unit: "percent",
      windowMinutes: window.minutes,
      ...(resetsAt === undefined ? {} : { resetsAt: new Date(resetsAt * 1000) }),
    });
  }
  return limits;
}

/** Turns one status line report into metrics; null when it is not one. */
export function metricsFromStatusLine(
  report: unknown,
  tokens: TerminalTokens | undefined,
  at: Date,
): TerminalMetrics | null {
  const sessionId = stringField(report, "session_id");
  if (!sessionId) {
    return null;
  }
  const model = stringField(report, "model", "display_name") ?? stringField(report, "model", "id");
  const activeMs = numberField(report, "cost", "total_duration_ms");
  const costUsd = numberField(report, "cost", "total_cost_usd");
  const contextTokens = numberField(report, "context_window", "total_input_tokens");
  const windowTokens = numberField(report, "context_window", "context_window_size");
  return {
    source: STATUS_LINE_SOURCE,
    providerSessionId: sessionId,
    ...(model === undefined ? {} : { model }),
    ...(activeMs === undefined ? {} : { activeMs }),
    ...(tokens === undefined ? {} : { tokens }),
    // Claude Code computes it at list price; it may differ from the bill.
    ...(costUsd === undefined ? {} : { costUsd, costEstimated: true }),
    ...(contextTokens === undefined || contextTokens === 0
      ? {}
      : {
          context: {
            usedTokens: contextTokens,
            ...(windowTokens === undefined || windowTokens <= 0 ? {} : { windowTokens }),
          },
        }),
    limits: limitsOf(report),
    updatedAt: at,
  };
}

/**
 * Adds up the tokens of a transcript. A response is written as several
 * records — one per content block — that repeat its usage, so each message id
 * counts once, with the last usage written for it.
 */
export class TranscriptTokens {
  readonly #follower: JsonLinesFollower;
  readonly #byMessage = new Map<string, TerminalTokens>();

  constructor(path: string) {
    this.#follower = new JsonLinesFollower(path);
  }

  get path(): string {
    return this.#follower.path;
  }

  async read(): Promise<TerminalTokens | undefined> {
    for (const record of await this.#follower.readNew()) {
      if (stringField(record, "type") !== "assistant") {
        continue;
      }
      const id = stringField(record, "message", "id") ?? stringField(record, "requestId");
      const usage = field(record, "message", "usage");
      const input = numberField(usage, "input_tokens");
      const output = numberField(usage, "output_tokens");
      if (!id || input === undefined || output === undefined) {
        continue;
      }
      this.#byMessage.set(id, {
        input,
        output,
        cacheRead: numberField(usage, "cache_read_input_tokens") ?? 0,
        cacheWrite: numberField(usage, "cache_creation_input_tokens") ?? 0,
      });
    }
    if (this.#byMessage.size === 0) {
      return undefined;
    }
    const total: Required<Pick<TerminalTokens, "input" | "output" | "cacheRead" | "cacheWrite">> = {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
    };
    for (const entry of this.#byMessage.values()) {
      total.input += entry.input;
      total.output += entry.output;
      total.cacheRead += entry.cacheRead ?? 0;
      total.cacheWrite += entry.cacheWrite ?? 0;
    }
    return total;
  }
}

/** Removes run files and folders of earlier runs, so the directory does not grow forever. */
async function sweep(directory: string, now: number): Promise<void> {
  let entries: string[];
  try {
    entries = await readdir(directory);
  } catch {
    return;
  }
  await Promise.all(
    entries.map(async (entry) => {
      const path = join(directory, entry);
      try {
        if (now - (await stat(path)).mtimeMs > RUN_FILE_TTL_MS) {
          await rm(path, { force: true, recursive: true });
        }
      } catch {
        // Gone already, or in use; either way not ours to worry about.
      }
    }),
  );
}

/** Where Claude Code keeps this entry's configuration. */
export function configHomeOf(context: CliExtensionContext): string {
  return (
    context.accountHome ??
    context.env["CLAUDE_CONFIG_DIR"] ??
    process.env["CLAUDE_CONFIG_DIR"] ??
    join(homedir(), ".claude")
  );
}

/**
 * Prepares one interactive run and says how to follow it: the status line
 * bridge for its numbers, and the hooks for what it waits on the person for.
 */
export async function statusLineTelemetry(
  context: CliExtensionContext,
  run: CliInteractiveRun,
): Promise<CliInteractiveTelemetry | null> {
  const directory = join(context.stateDirectory, "runs");
  await mkdir(directory, { recursive: true });
  void sweep(directory, Date.now());

  // PowerShell on Windows, the POSIX shell everywhere else. Without the shell
  // the bridge needs, no bridge is installed at all: a status line command
  // that cannot run would take the person's own status line with it.
  const windows = process.platform === "win32";
  if (!windows && !existsSync(POSIX_SHELL)) {
    return null;
  }

  const script = join(
    context.stateDirectory,
    windows ? "statusline-bridge.ps1" : "statusline-bridge.sh",
  );
  // Written with a byte order mark: Windows PowerShell reads a file without
  // one in the legacy code page.
  await writeFile(script, windows ? `\uFEFF${BRIDGE_SCRIPT}` : POSIX_BRIDGE_SCRIPT, "utf8");

  // The hooks report what the run waits on the person for (./attention.ts).
  const hookScript = join(context.stateDirectory, windows ? "hook-bridge.ps1" : "hook-bridge.sh");
  await writeFile(
    hookScript,
    windows ? `\uFEFF${POWERSHELL_HOOK_SCRIPT}` : POSIX_HOOK_SCRIPT,
    "utf8",
  );
  const hookDirectory = join(directory, `${run.runId}.hooks`);
  await mkdir(hookDirectory, { recursive: true });
  const hooks = new ClaudeHookState(hookDirectory);

  const output = join(directory, `${run.runId}.status.json`);
  const settingsFile = join(directory, `${run.runId}.settings.json`);
  const userStatusLine = await findUserStatusLine(run.workingDirectory, configHomeOf(context));
  const shell = windows ? findGitBash({ ...process.env, ...context.env }) : POSIX_SHELL;
  const chain = userStatusLine
    ? await writeChainScript(directory, run.runId, userStatusLine, shell, output)
    : null;
  await writeFile(
    settingsFile,
    `${JSON.stringify(
      {
        statusLine: {
          type: "command",
          command: windows
            ? bridgeCommand({ script, output, chain, shell })
            : posixBridgeCommand({ script, output, chain }),
          ...(userStatusLine?.padding === undefined ? {} : { padding: userStatusLine.padding }),
        },
        // Added to the person's own hooks, which Claude Code keeps running.
        hooks: hookSettings((event) =>
          (windows ? powershellHookCommand : posixHookCommand)({
            script: hookScript,
            directory: hookDirectory,
            event,
            waits: event === "PermissionRequest",
          }),
        ),
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  return {
    args: ["--settings", settingsFile],
    source: STATUS_LINE_SOURCE,
    watch: (onMetrics) => {
      let seen: number | null = null;
      let report: unknown = null;
      let reportAt = 0;
      let transcript: TranscriptTokens | null = null;
      let tokens: TerminalTokens | undefined;
      return poll(async () => {
        let changed = false;
        const changedAt = await modifiedAt(output);
        if (changedAt !== null && changedAt !== seen) {
          seen = changedAt;
          const next = await readJsonFile(output);
          if (next !== null) {
            report = next;
            reportAt = changedAt;
            changed = true;
            const transcriptPath = stringField(next, "transcript_path");
            if (transcriptPath && transcript?.path !== transcriptPath) {
              // A new session (e.g. after /clear) has its own transcript.
              transcript = new TranscriptTokens(transcriptPath);
              tokens = undefined;
            }
          }
        }
        // Tokens also grow between reports while a response streams.
        if (transcript) {
          const next = await transcript.read();
          if (next && JSON.stringify(next) !== JSON.stringify(tokens)) {
            tokens = next;
            changed = true;
          }
        }
        if (changed && report !== null) {
          const metrics = metricsFromStatusLine(report, tokens, new Date(reportAt));
          if (metrics) {
            onMetrics(metrics);
          }
        }
      }, POLL_MS);
    },
    ...hookTelemetry(hooks),
  };
}
