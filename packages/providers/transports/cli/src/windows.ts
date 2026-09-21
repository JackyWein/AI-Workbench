import { existsSync, readFileSync, statSync } from "node:fs";
import { delimiter, dirname, extname, isAbsolute, join, resolve } from "node:path";

/** What to hand to `child_process.spawn` for one executable and its arguments. */
export interface SpawnTarget {
  readonly command: string;
  readonly args: string[];
  /**
   * The arguments are already quoted for cmd.exe and must reach it verbatim;
   * Node's own quoting would double them.
   */
  readonly windowsVerbatimArguments: boolean;
  /** Variables the target needs on top of the caller's environment. */
  readonly env?: Record<string, string>;
}

/**
 * Windows cannot start a `.cmd` or `.bat` file without a shell, and Node
 * refuses to try. Yet that is how npm installs every command line tool there.
 *
 * An npm shim is only a launcher for a JavaScript file, so when the file is one
 * we run that script with Node directly: no shell, arguments passed as an
 * array, exactly as on the other platforms. Any other batch file has to go
 * through cmd.exe, and then every argument is escaped for it so that nothing a
 * prompt contains can become a command.
 */
export function resolveSpawnTarget(
  executablePath: string,
  args: readonly string[],
  platform: NodeJS.Platform = process.platform,
  comSpec: string = process.env["ComSpec"] ?? "cmd.exe",
): SpawnTarget {
  const extension = extname(executablePath).toLowerCase();
  if (platform !== "win32" || (extension !== ".cmd" && extension !== ".bat")) {
    return { command: executablePath, args: [...args], windowsVerbatimArguments: false };
  }

  const shim = readNpmShim(executablePath);
  if (shim) {
    const node = shim.node ?? findNodeOnPath();
    if (node) {
      return { command: node, args: [shim.script, ...args], windowsVerbatimArguments: false };
    }
    // No Node on this machine: the application's own runtime can run the
    // script, told to behave as plain Node rather than as an application.
    if (process.versions["electron"]) {
      return {
        command: process.execPath,
        args: [shim.script, ...args],
        windowsVerbatimArguments: false,
        env: { ELECTRON_RUN_AS_NODE: "1" },
      };
    }
  }

  const line = [quoteForCmd(executablePath, false), ...args.map((arg) => quoteForCmd(arg, true))]
    .join(" ");
  return {
    command: comSpec,
    args: ["/d", "/s", "/c", `"${line}"`],
    windowsVerbatimArguments: true,
  };
}

/**
 * Reads the script an npm-generated shim launches. npm writes
 * `"%dp0%\node_modules\...\cli.js" %*` (older versions use `%~dp0`); anything
 * else is not recognised and falls back to cmd.exe.
 */
export function readNpmShim(
  shimPath: string,
): { readonly node: string | null; readonly script: string } | null {
  let content: string;
  try {
    content = readFileSync(shimPath, "utf8");
  } catch {
    return null;
  }

  const match = /"%~?dp0%?\\?([^"%]+\.(?:c|m)?js)"\s+%\*/i.exec(content);
  if (!match?.[1]) {
    return null;
  }

  const directory = dirname(shimPath);
  const script = resolve(directory, match[1]);
  if (!existsSync(script)) {
    return null;
  }

  // npm prefers a node.exe that sits next to the shim, as the shim itself does.
  const bundled = join(directory, "node.exe");
  return { node: existsSync(bundled) ? bundled : null, script };
}

function findNodeOnPath(): string | null {
  for (const directory of (process.env["PATH"] ?? "").split(delimiter).filter(Boolean)) {
    const candidate = join(directory, "node.exe");
    try {
      if (statSync(candidate).isFile()) {
        return candidate;
      }
    } catch {
      // Not in this directory.
    }
  }
  return null;
}

/**
 * Quotes one argument for `cmd.exe /d /s /c "..."`, following the rules
 * cross-spawn established: first the quoting CommandLineToArgvW expects, then
 * every cmd.exe metacharacter escaped with a caret. Arguments to a batch file
 * are parsed by cmd.exe twice, hence the second pass.
 */
export function quoteForCmd(argument: string, doubleEscape: boolean): string {
  let value = argument;

  if (!isAbsolute(value) || /[\s"]/.test(value)) {
    // Backslashes before a quote are doubled, then the quote is escaped.
    value = value.replace(/(\\*)"/g, '$1$1\\"');
    // Trailing backslashes are doubled so they do not escape the closing quote.
    value = value.replace(/(\\*)$/, "$1$1");
    value = `"${value}"`;
  }

  const metacharacters = /([()\][%!^"`<>&|;, *?])/g;
  value = value.replace(metacharacters, "^$1");
  if (doubleEscape) {
    value = value.replace(metacharacters, "^$1");
  }
  return value;
}
