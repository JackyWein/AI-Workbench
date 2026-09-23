import {
  HOOK_DIR_ENV,
  HookState,
  describeToolInput,
  hookCommandFor,
  hookTelemetry,
  prepareHookRun,
  type CliExtensionContext,
  type CliInteractiveRun,
  type CliInteractiveTelemetry,
  type HookDialect,
} from "@ai-workbench/provider-cli";

/**
 * What an interactive Codex run waits on the person for, and whether it is
 * working or idle, through Codex's own command hooks — the same hook model as
 * Claude Code, so the shared bridge in the CLI package does the work.
 *
 * Measured against Codex 0.156.1 in its interactive interface, with a local
 * stand-in model, before this was built:
 *
 * - Codex asks the person to trust new or changed hooks ("Hooks need review")
 *   and remembers the answer per hook, so the hook command never changes
 *   between runs; the run's folder travels in the environment. Hooks the
 *   person configured themselves keep running next to these.
 * - `PermissionRequest` reports a command that needs approval, as tool
 *   "Bash" with its command. Unlike Claude Code, Codex shows **no dialog
 *   while that hook runs** — a hook that waited would block the person — so
 *   the hook only reports, and Codex's own dialog appears at once.
 * - That dialog takes "y" (yes, proceed) and Esc (no, and tell Codex what to
 *   do differently). Typing them into the tile runs the command, or ends the
 *   turn with the `Interrupt` hook — exactly as in the terminal.
 * - A turn starts with `UserPromptSubmit` (after `SessionStart` on the first
 *   prompt) and ends with `Stop`, or with `Interrupt` when the person stops
 *   it; a command that ran reports `PostToolUse`.
 */

export const CODEX_HOOK_SOURCE = "Codex hooks";

/** The hooks a run is started with; none of them ever waits. */
export const CODEX_HOOK_EVENTS = [
  "SessionStart",
  "UserPromptSubmit",
  "PermissionRequest",
  "PostToolUse",
  "Stop",
  "Interrupt",
] as const;

/** The tool whose dialog was measured; other approvals are answered in the tile. */
const ANSWERABLE_TOOL = "Bash";

/** Codex's hooks, as the shared hook state reads them. */
export const codexDialect: HookDialect = {
  permissionEvent: "PermissionRequest",
  answerBy: "keys",
  toolDone: ["PostToolUse"],
  turnStart: ["UserPromptSubmit"],
  turnEnd: ["SessionStart", "Stop", "Interrupt"],
  describe: (id, tool, input, since) => ({
    id,
    kind: "permission",
    tool,
    summary: describeToolInput(input),
    choices: [],
    answerable: tool === ANSWERABLE_TOOL,
    since,
  }),
  // The keys Codex's own approval dialog takes.
  answer: (request, response) => {
    if (!("decision" in response) || request.attention.kind !== "permission") {
      return null;
    }
    return response.decision === "allow" ? "y" : "\u001b";
  },
};

/** A TOML basic string. */
function tomlString(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/**
 * The `-c` overrides that add the bridge's hooks for one run. They sit in
 * Codex's session layer; hooks from the person's own configuration still run.
 */
export function codexHookArgs(command: (event: string) => string): string[] {
  return CODEX_HOOK_EVENTS.flatMap((event) => {
    // The permission hook reports before Codex draws its dialog, so it runs
    // in order; the others only report and never slow Codex down.
    const handler =
      event === "PermissionRequest"
        ? `{type="command",command=${tomlString(command(event))},timeout=30}`
        : `{type="command",command=${tomlString(command(event))},async=true}`;
    return ["-c", `hooks.${event}=[{matcher="",hooks=[${handler}]}]`];
  });
}

/** The waiting and working parts of one run's telemetry, from Codex's hooks. */
export async function codexHookTelemetry(
  context: CliExtensionContext,
  run: CliInteractiveRun,
): Promise<Pick<
  CliInteractiveTelemetry,
  "args" | "env" | "watchAttention" | "watchActivity" | "respond"
> | null> {
  const hookRun = await prepareHookRun(context.stateDirectory, run.runId);
  if (!hookRun) {
    return null;
  }
  const state = new HookState(hookRun.directory, codexDialect);
  return {
    args: codexHookArgs((event) => hookCommandFor(hookRun, event, false)),
    env: { [HOOK_DIR_ENV]: hookRun.directory },
    ...hookTelemetry(state),
  };
}
