import { dirname } from "node:path";
import type { PermissionMode } from "@ai-workbench/shared";
import type { CliMcpLaunch } from "./mcp.js";
import {
  substitute,
  type CliAttachments,
  type CliProviderProfile,
  type PermissionArgs,
} from "./profile.js";

/** A file going with a turn, already on this computer. */
export interface TurnAttachment {
  readonly kind: "image" | "file";
  readonly path: string;
}

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
  readonly attachments?: readonly TurnAttachment[];
}

/** The values `{placeholders}` in a profile resolve to. */
function placeholderValues(
  input: Partial<Omit<TurnInput, "mcp" | "attachments">>,
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
 * instructions, MCP servers, resume (when appended), attached files, prompt,
 * trailing.
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
  args.push(...attachmentArgs(profile.attachments, input.attachments ?? []));
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

/** Whether the tool takes this file through a flag of its own. */
function byFlag(settings: CliAttachments, attachment: TurnAttachment): boolean {
  return (
    (attachment.kind === "image" && settings.imageArgs.length > 0) || settings.fileArgs.length > 0
  );
}

/** Flags for the files a tool takes directly, and the folders it must read. */
function attachmentArgs(
  settings: CliAttachments | undefined,
  attachments: readonly TurnAttachment[],
): string[] {
  if (!settings || attachments.length === 0) {
    return [];
  }
  const args: string[] = [];
  const folders = new Set<string>();
  for (const attachment of attachments) {
    if (!byFlag(settings, attachment)) {
      folders.add(dirname(attachment.path));
      continue;
    }
    const flag =
      attachment.kind === "image" && settings.imageArgs.length > 0
        ? settings.imageArgs
        : settings.fileArgs;
    args.push(...(substitute(flag, { path: attachment.path }) ?? []));
  }
  if (settings.directoryArgs.length > 0) {
    for (const directory of folders) {
      args.push(...(substitute(settings.directoryArgs, { directory }) ?? []));
    }
  }
  return args;
}

/**
 * The prompt with the files the tool does not take by flag: mentioned the
 * way the tool reads mentions, or listed so it can open them itself.
 */
export function promptWithAttachments(
  profile: CliProviderProfile,
  text: string,
  attachments: readonly TurnAttachment[],
  platform: NodeJS.Platform = process.platform,
): string {
  const settings = profile.attachments;
  const rest = settings ? attachments.filter((entry) => !byFlag(settings, entry)) : attachments;
  if (rest.length === 0) {
    return text;
  }
  if (settings?.mentionPrefix) {
    const prefix = settings.mentionPrefix;
    return `${text}\n\n${rest.map((entry) => `${prefix}${mentionPath(entry.path, platform)}`).join("\n")}`;
  }
  const lines = rest.map((entry) => `- ${entry.path}`);
  return `${text}\n\nAttached files (read them from these paths):\n${lines.join("\n")}`;
}

/**
 * Instructions for a tool that takes none by flag travel in front of the
 * message instead: with the first message of a conversation, and with every
 * message when the tool starts each turn afresh. Without this, skills and
 * what the connected servers are for reached only the tools with a flag for
 * them and were dropped for the others without a word.
 */
export function promptWithInstructions(
  profile: CliProviderProfile,
  text: string,
  instructions: string | undefined,
  firstTurn: boolean,
): string {
  const wanted = instructions?.trim() ?? "";
  if (wanted.length === 0 || profile.instructionArgs.length > 0) {
    return text;
  }
  if (!firstTurn && profile.capabilities.includes("sessionResume")) {
    return text;
  }
  return `<instructions>\n${wanted}\n</instructions>\n\n${text}`;
}

/**
 * A path as a mention parser reads it: special characters behind a
 * backslash, or on Windows — where the backslash separates folders — the
 * whole path in double quotes.
 */
export function mentionPath(path: string, platform: NodeJS.Platform): string {
  if (platform === "win32") {
    return /[\s&()[\]{}^=;!'+,`~%$@#]/.test(path) ? `"${path}"` : path;
  }
  return path.replace(/([ \t()[\]{};|*?$`'"#&<>!~\\,])/g, "\\$1");
}
