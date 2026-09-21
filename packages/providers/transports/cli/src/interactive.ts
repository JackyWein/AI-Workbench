import { resolveSpawnTarget } from "./windows.js";

/** How to start a tool's own interactive interface: what an adapter describes. */
export interface InteractiveCommandRequest {
  /** Absolute path of the executable, as located by the transport. */
  readonly command: string;
  readonly args: readonly string[];
  /** Variables the tool needs on top of the application's environment. */
  readonly env?: Readonly<Record<string, string>>;
}

/** What to hand to a pseudo terminal (node-pty's `spawn(file, args, options)`). */
export interface InteractiveCommand {
  readonly file: string;
  /**
   * The arguments as an array, or — when they were already quoted for cmd.exe
   * — one command line that must reach it unchanged. node-pty passes a string
   * through verbatim on Windows and would re-quote an array, breaking the
   * quoting cmd.exe needs.
   */
  readonly args: string[] | string;
  /** Merged over the application's environment by whoever starts it. */
  readonly env: Record<string, string>;
}

/**
 * Applies the same Windows launch rules a headless run gets (spec §12, §26):
 * an npm `.cmd` shim runs its script with Node directly, any other batch file
 * goes through cmd.exe with every argument escaped. Without this a terminal
 * agent for a tool installed through npm could not start at all, since a
 * `.cmd` file is not an executable a pseudo terminal can spawn.
 */
export function resolveInteractiveCommand(
  launch: InteractiveCommandRequest,
  platform: NodeJS.Platform = process.platform,
  comSpec?: string,
): InteractiveCommand {
  const target = resolveSpawnTarget(launch.command, launch.args, platform, comSpec);
  return {
    file: target.command,
    args: target.windowsVerbatimArguments ? target.args.join(" ") : target.args,
    env: { ...launch.env, ...target.env },
  };
}
