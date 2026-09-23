import type { CliExtensionContext } from "@ai-workbench/provider-cli";

/**
 * OpenCode 2 changed its command line (read from its source, tag v2.0.15):
 *
 * - `run` still takes `--format json`, `--session`, `--model` and `--auto`,
 *   but a model's variant is part of the model, `--model provider/model#high`;
 *   the `--variant` flag of 1.x is gone and fails the whole turn.
 * - The terminal interface takes no `--model`, and it talks to OpenCode's
 *   background service instead of opening a server of its own, so the root
 *   `--port`/`--hostname` flags of 1.x are gone too.
 *
 * Both releases read their project folder from PWD before the working folder;
 * the transport sets PWD for every tool it starts.
 */

/** The installed OpenCode's major version, or null when it cannot say. */
export async function opencodeMajor(context: CliExtensionContext): Promise<number | null> {
  const version = await context.version();
  return version === null ? null : parseMajor(version);
}

/** "2.0.15", "opencode 1.18.32" → 2, 1; a dev build ("0.0.0-dev-…") → 0. */
export function parseMajor(text: string): number | null {
  const match = /(\d+)\.\d+\.\d+/.exec(text);
  return match?.[1] === undefined ? null : Number(match[1]);
}

/** Removes `flag value` pairs from an argument list, returning the values. */
function take(args: string[], flag: string): string[] {
  const values: string[] = [];
  for (let index = args.indexOf(flag); index !== -1; index = args.indexOf(flag)) {
    const value = args[index + 1];
    args.splice(index, value === undefined ? 1 : 2);
    if (value !== undefined) {
      values.push(value);
    }
  }
  return values;
}

/**
 * The arguments as OpenCode 2 takes them. A turn keeps its model and moves
 * the variant into it; the terminal interface loses both, since it has no
 * way to take them, and the server flags it no longer has.
 */
export function argsForOpencode2(
  input: readonly string[],
  kind: "turn" | "interactive",
): string[] {
  // Only options are rewritten: whatever follows "--" is the prompt, and a
  // prompt that happens to read "--model" stays the person's words.
  const end = input.indexOf("--");
  const args = end === -1 ? [...input] : input.slice(0, end);
  const rest = end === -1 ? [] : input.slice(end);
  const variant = take(args, "--variant").at(-1);
  if (kind === "interactive") {
    take(args, "--model");
    take(args, "--port");
    take(args, "--hostname");
    return [...args, ...rest];
  }
  if (variant) {
    const at = args.indexOf("--model");
    const model = at === -1 ? undefined : args[at + 1];
    if (model !== undefined && !model.includes("#")) {
      args[at + 1] = `${model}#${variant}`;
    }
  }
  return [...args, ...rest];
}

/** The extension hook: 1.x keeps its arguments, 2.x gets its own. */
export async function adaptOpencodeArgs(
  args: readonly string[],
  kind: "turn" | "interactive",
  context: CliExtensionContext,
): Promise<string[] | null> {
  const major = await opencodeMajor(context);
  return major !== null && major >= 2 ? argsForOpencode2(args, kind) : null;
}
