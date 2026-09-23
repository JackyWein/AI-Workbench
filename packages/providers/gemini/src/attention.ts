import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  HOOK_DIR_ENV,
  HookState,
  POSIX_HOOK_SCRIPT,
  POWERSHELL_HOOK_SCRIPT,
  describeToolInput,
  field,
  hookTelemetry,
  numberField,
  posixHookCommand,
  powershellHookCommand,
  prepareHookRun,
  stringField,
  type CliExtensionContext,
  type CliInteractiveRun,
  type CliInteractiveTelemetry,
  type HookDialect,
} from "@ai-workbench/provider-cli";
import type { ProviderIntegration, TerminalMetrics } from "@ai-workbench/shared";

/**
 * What an interactive Gemini CLI run waits on the person for, and whether it
 * is working or idle, through Gemini CLI's own hooks.
 *
 * Measured against Gemini CLI 0.60 in its interactive interface, with a local
 * stand-in for the Gemini API, before this was built:
 *
 * - Hooks cannot be handed to one run. The only per-run settings layer that
 *   carries them, the system settings file, is skipped unless root owns it
 *   (an administrator on Windows) — by design, and not worked around here.
 *   An extension may carry hooks (`hooks/hooks.json`), so the island's hooks
 *   ship as a small extension the person installs once with Gemini CLI's own
 *   installer, answering its own questions. Outside the Workbench the hooks
 *   find no run folder in their environment and do nothing.
 * - Hooks run with the run's environment variables, so the run's folder
 *   travels there, as for the other tools.
 * - A command that needs approval reports `BeforeTool` (the tool and its
 *   input) and then `Notification` of type `ToolPermission`, which a hook can
 *   only observe. The dialog takes "1" (allow once) and Esc (no); both were
 *   typed into the real interface: "1" ran the command, Esc ran nothing.
 * - A turn starts with `BeforeAgent` and ends with `AfterAgent`. A refused or
 *   interrupted turn ends with no hook at all; the session transcript then
 *   records `{"type":"info","content":"Request cancelled."}`.
 */

export const GEMINI_HOOK_SOURCE = "Gemini CLI hooks";
export const GEMINI_TRANSCRIPT_SOURCE = "Gemini CLI session transcript";

/** The extension's name, as Gemini CLI lists it. */
export const ISLAND_EXTENSION = "ai-workbench-island";
/** Raised whenever the extension's files change, so an update is offered. */
export const ISLAND_EXTENSION_VERSION = "1.0.0";

/** The events the extension reports; none of them waits. */
export const GEMINI_HOOK_EVENTS = [
  "SessionStart",
  "SessionEnd",
  "BeforeAgent",
  "AfterAgent",
  "BeforeTool",
  "AfterTool",
  "Notification",
] as const;

/** Gemini CLI's own names for its tools, as its dialogs show them. */
const TOOL_LABELS: Readonly<Record<string, string>> = {
  run_shell_command: "Shell",
  write_file: "WriteFile",
  replace: "Edit",
  read_file: "ReadFile",
  web_fetch: "WebFetch",
  google_web_search: "GoogleSearch",
};

/** The tool whose dialog was measured; other approvals are answered in the tile. */
const ANSWERABLE_TOOL = "run_shell_command";

/** How Gemini CLI records a turn the person refused or interrupted. */
const CANCELLED = "Request cancelled";

/** Gemini CLI's hooks, as the shared hook state reads them. */
export const geminiDialect: HookDialect = {
  permissionEvent: "Notification",
  answerBy: "keys",
  toolStart: "BeforeTool",
  permissionOf: (body, announced) => {
    if (stringField(body, "notification_type") !== "ToolPermission") {
      return null;
    }
    const details = field(body, "details");
    const command = stringField(details, "command");
    // The tool announced just before is the one asked about, unless the
    // notification names a different command.
    if (announced && (!command || stringField(announced.input, "command") === command)) {
      return announced;
    }
    return {
      tool:
        stringField(details, "type") === "exec"
          ? ANSWERABLE_TOOL
          : (stringField(details, "title") ?? "a tool"),
      input: details,
    };
  },
  toolDone: ["AfterTool"],
  turnStart: ["BeforeAgent"],
  turnEnd: ["AfterAgent", "SessionStart", "SessionEnd"],
  describe: (id, tool, input, since) => ({
    id,
    kind: "permission",
    tool: TOOL_LABELS[tool] ?? tool,
    summary: describeToolInput(input),
    choices: [],
    answerable: tool === ANSWERABLE_TOOL,
    since,
  }),
  // The keys Gemini CLI's own approval dialog takes.
  answer: (request, response) => {
    if (!("decision" in response) || request.attention.kind !== "permission") {
      return null;
    }
    return response.decision === "allow" ? "1" : "\u001b";
  },
  endsTurn: (record) =>
    stringField(record, "type") === "info" &&
    (stringField(record, "content") ?? "").startsWith(CANCELLED),
};

/** Where Gemini CLI keeps its configuration for this entry. */
function geminiHome(context: CliExtensionContext): string {
  return context.env["GEMINI_CLI_HOME"] ?? process.env["GEMINI_CLI_HOME"] ?? homedir();
}

/** The extension's files, in the form Gemini CLI installs them from. */
export function islandExtensionFiles(platform: NodeJS.Platform): Record<string, string> {
  const windows = platform === "win32";
  // Gemini CLI replaces ${extensionPath} and ${/} when it loads the hooks.
  const script = windows
    ? "${extensionPath}${/}hook-bridge.ps1"
    : "${extensionPath}${/}hook-bridge.sh";
  const command = (event: string): string =>
    (windows ? powershellHookCommand : posixHookCommand)({ script, event, waits: false });
  return {
    "gemini-extension.json": `${JSON.stringify(
      {
        name: ISLAND_EXTENSION,
        version: ISLAND_EXTENSION_VERSION,
        description:
          "Tells AI Workbench when Gemini CLI waits for you or works. Does nothing outside AI Workbench.",
      },
      null,
      2,
    )}\n`,
    [join("hooks", "hooks.json")]: `${JSON.stringify(
      {
        hooks: Object.fromEntries(
          GEMINI_HOOK_EVENTS.map((event) => [
            event,
            [{ matcher: "", hooks: [{ type: "command", command: command(event), timeout: 10_000 }] }],
          ]),
        ),
      },
      null,
      2,
    )}\n`,
    [windows ? "hook-bridge.ps1" : "hook-bridge.sh"]: windows
      ? POWERSHELL_HOOK_SCRIPT
      : POSIX_HOOK_SCRIPT,
  };
}

/** Writes the extension where Gemini CLI installs it from; returns that folder. */
async function writeIslandExtension(context: CliExtensionContext): Promise<string> {
  const directory = join(context.stateDirectory, "gemini-extension", ISLAND_EXTENSION);
  for (const [name, content] of Object.entries(islandExtensionFiles(process.platform))) {
    const path = join(directory, name);
    await mkdir(join(path, ".."), { recursive: true });
    const current = await readFile(path, "utf8").catch(() => null);
    if (current !== content) {
      await writeFile(path, content, "utf8");
    }
  }
  return directory;
}

interface InstalledExtension {
  readonly version: string | null;
  readonly disabled: boolean;
}

/** The extension as Gemini CLI has it installed; null when it is not. */
async function installedExtension(context: CliExtensionContext): Promise<InstalledExtension | null> {
  const extensions = join(geminiHome(context), ".gemini", "extensions");
  let manifest: unknown;
  try {
    manifest = JSON.parse(
      await readFile(join(extensions, ISLAND_EXTENSION, "gemini-extension.json"), "utf8"),
    );
  } catch {
    return null;
  }
  let disabled = false;
  try {
    const enablement: unknown = JSON.parse(
      await readFile(join(extensions, "extension-enablement.json"), "utf8"),
    );
    const overrides = field(enablement, ISLAND_EXTENSION, "overrides");
    // "!<path>/*" is how Gemini CLI records an extension turned off.
    disabled =
      Array.isArray(overrides) &&
      overrides.some((entry) => typeof entry === "string" && entry.startsWith("!"));
  } catch {
    // No record: enabled, Gemini CLI's default.
  }
  return { version: stringField(manifest, "version") ?? null, disabled };
}

const DESCRIPTION =
  "Lets the status island show when Gemini CLI waits for you, works or rests, " +
  "and answer its shell prompts. Installs a small extension with Gemini CLI's " +
  "own installer, which asks you first; it does nothing outside AI Workbench.";

/** Whether the island's extension is installed, current and on. */
export async function islandIntegration(
  context: CliExtensionContext,
): Promise<ProviderIntegration | null> {
  if (!(await context.locate())) {
    return null;
  }
  await writeIslandExtension(context);
  const installed = await installedExtension(context);
  if (!installed) {
    return { name: "Status island", description: DESCRIPTION, state: "setupNeeded" };
  }
  if (installed.disabled) {
    return {
      name: "Status island",
      description: DESCRIPTION,
      state: "setupNeeded",
      detail: `The ${ISLAND_EXTENSION} extension is installed but turned off in Gemini CLI.`,
    };
  }
  if (installed.version !== ISLAND_EXTENSION_VERSION) {
    return { name: "Status island", description: DESCRIPTION, state: "updateNeeded" };
  }
  return { name: "Status island", description: DESCRIPTION, state: "ready" };
}

/** Gemini CLI's own command for what the island needs; null when all is done. */
export async function islandSetupArgs(context: CliExtensionContext): Promise<string[] | null> {
  const source = await writeIslandExtension(context);
  const installed = await installedExtension(context);
  if (!installed) {
    // No --consent: Gemini CLI shows its own notice and asks.
    return ["extensions", "install", source];
  }
  if (installed.disabled) {
    return ["extensions", "enable", ISLAND_EXTENSION];
  }
  if (installed.version !== ISLAND_EXTENSION_VERSION) {
    return ["extensions", "update", ISLAND_EXTENSION];
  }
  return null;
}

/**
 * Sums a session transcript of Gemini CLI: one JSON record per line, the
 * session id first, each answer of the model with its token counts (records
 * may be written again under the same id, and `$set` lines rewrite fields).
 */
export function metricsFromTranscript(text: string, at: Date): TerminalMetrics | null {
  let sessionId: string | undefined;
  const answers = new Map<string, unknown>();
  for (const line of text.split("\n")) {
    if (!line.trim()) {
      continue;
    }
    let record: unknown;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    sessionId ??= stringField(record, "sessionId");
    const id = stringField(record, "id");
    if (id && stringField(record, "type") === "gemini" && field(record, "tokens") !== undefined) {
      answers.set(id, record);
    }
  }
  if (answers.size === 0) {
    return null;
  }
  let model: string | undefined;
  const tokens = { input: 0, output: 0, cacheRead: 0, reasoning: 0 };
  for (const answer of answers.values()) {
    const cached = numberField(answer, "tokens", "cached") ?? 0;
    tokens.input += Math.max(0, (numberField(answer, "tokens", "input") ?? 0) - cached);
    tokens.cacheRead += cached;
    tokens.output += numberField(answer, "tokens", "output") ?? 0;
    tokens.reasoning += numberField(answer, "tokens", "thoughts") ?? 0;
    model = stringField(answer, "model") ?? model;
  }
  return {
    source: GEMINI_TRANSCRIPT_SOURCE,
    ...(sessionId === undefined ? {} : { providerSessionId: sessionId }),
    ...(model === undefined ? {} : { model }),
    tokens,
    limits: [],
    updatedAt: at,
  };
}

/** The waiting and working parts of one run's telemetry, from the island's extension. */
export async function geminiHookTelemetry(
  context: CliExtensionContext,
  run: CliInteractiveRun,
): Promise<
  | (Pick<CliInteractiveTelemetry, "env" | "watchAttention" | "watchActivity" | "respond"> & {
      /** The session transcript the hooks named; null before they named one. */
      readonly transcriptPath: () => string | null;
    })
  | null
> {
  const hookRun = await prepareHookRun(context.stateDirectory, run.runId);
  if (!hookRun) {
    return null;
  }
  const state = new HookState(hookRun.directory, geminiDialect);
  return {
    env: { [HOOK_DIR_ENV]: hookRun.directory },
    transcriptPath: () => state.transcriptPath,
    ...hookTelemetry(state),
  };
}
