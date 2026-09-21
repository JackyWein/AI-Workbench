import type { PermissionMode } from "@ai-workbench/shared";
import type { CliMcpLaunch } from "./mcp.js";
import { substitute, type CliProviderProfile, type PermissionArgs } from "./profile.js";

/** Everything one turn's command line is assembled from. */
export interface TurnInput {
  readonly prompt: string;
  readonly sessionId: string;
  /** Undefined until the tool has assigned its own id: then nothing resumes. */
  readonly providerSessionId: string | undefined;
  readonly modelId: string | undefined;
  readonly reasoningEffort: string | undefined;
  readonly permissionMode: PermissionMode | undefined;
  readonly systemInstructions: string | undefined;
  readonly workingDirectory: string | undefined;
  readonly mcp: CliMcpLaunch;
}

/** The values `{placeholders}` in a profile resolve to. */
function placeholderValues(
  input: Partial<Omit<TurnInput, "mcp">>,
): Record<string, string | undefined> {
  return {
    model: input.modelId,
    effort: input.reasoningEffort,
    prompt: input.prompt,
    sessionId: input.sessionId,
    providerSessionId: input.providerSessionId,
    systemInstructions: input.systemInstructions,
    workingDirectory: input.workingDirectory,
  };
}

/**
 * The arguments for one headless turn, in a fixed order (spec §12, §16):
 * base (or resume, when resuming replaces them), model, effort, permission,
 * instructions, MCP servers, resume (when appended), prompt, trailing.
 *
 * A group whose placeholder cannot be resolved is left out entirely, which is
 * how a first turn omits the resume flag and an unset effort adds nothing.
 */
export function buildTurnArgs(profile: CliProviderProfile, input: TurnInput): string[] {
  const values = placeholderValues(input);

  const resumeArgs =
    profile.resumeArgs.length > 0 ? substitute(profile.resumeArgs, values) : null;

  const args =
    resumeArgs && profile.resumeMode === "replace"
      ? [...resumeArgs]
      : [...(substitute(profile.args, values) ?? profile.args)];

  args.push(
    ...optionArgs(profile, profile.permissionArgs, profile.instructionArgs, input, values),
    ...input.mcp.args,
  );

  if (resumeArgs && profile.resumeMode === "append") {
    args.push(...resumeArgs);
  }
  if (profile.promptVia === "arg") {
    args.push(...(substitute(profile.promptArgs, values) ?? []));
  }
  args.push(...(substitute(profile.trailingArgs, values) ?? []));
  return args;
}

/** What starting the tool's interactive interface needs (spec §26). */
export interface InteractiveInput {
  readonly modelId: string | undefined;
  readonly reasoningEffort: string | undefined;
  readonly permissionMode: PermissionMode | undefined;
  readonly systemInstructions: string | undefined;
  readonly workingDirectory: string;
  readonly mcp: CliMcpLaunch;
}

/**
 * The interactive interface shares the model and effort arguments with a
 * headless turn. Its permission arguments override the headless ones per mode,
 * as the profile documents ("where they differ"), and its instruction
 * arguments replace them when given.
 */
export function buildInteractiveArgs(
  profile: CliProviderProfile,
  input: InteractiveInput,
): string[] {
  const interactive = profile.interactive;
  if (!interactive) {
    return [];
  }
  const values = placeholderValues(input);
  const permissionArgs: PermissionArgs = {
    ...profile.permissionArgs,
    ...definedEntries(interactive.permissionArgs ?? {}),
  };
  return [
    ...(substitute(interactive.args, values) ?? interactive.args),
    ...optionArgs(
      profile,
      permissionArgs,
      interactive.instructionArgs ?? profile.instructionArgs,
      input,
      values,
    ),
    ...input.mcp.args,
  ];
}

/** Model, effort, permission and instruction arguments, shared by both modes. */
function optionArgs(
  profile: CliProviderProfile,
  permissionArgs: PermissionArgs,
  instructionArgs: readonly string[],
  input: Pick<TurnInput, "modelId" | "reasoningEffort" | "permissionMode" | "systemInstructions">,
  values: Record<string, string | undefined>,
): string[] {
  const args: string[] = [];
  if (input.modelId && profile.modelArgs.length > 0) {
    args.push(...(substitute(profile.modelArgs, values) ?? []));
  }
  if (input.reasoningEffort && profile.effortArgs.length > 0) {
    args.push(...(substitute(profile.effortArgs, values) ?? []));
  }
  // No mode means the tool's own configuration decides, exactly like
  // "default": nothing is added unless the profile maps "default" itself.
  const permission = permissionArgs[input.permissionMode ?? "default"];
  if (permission && permission.length > 0) {
    args.push(...(substitute(permission, values) ?? []));
  }
  if (input.systemInstructions?.trim() && instructionArgs.length > 0) {
    args.push(...(substitute([...instructionArgs], values) ?? []));
  }
  return args;
}

function definedEntries(value: PermissionArgs): PermissionArgs {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined),
  ) as PermissionArgs;
}
