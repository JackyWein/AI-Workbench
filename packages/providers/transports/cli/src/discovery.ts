import { access, constants, stat } from "node:fs/promises";
import { delimiter, isAbsolute, join, resolve } from "node:path";
import { execCli } from "./process.js";

export interface ExecutableLocation {
  readonly path: string;
  readonly source: "configured" | "path";
}

/**
 * Finds an executable the way a shell would, without invoking one (spec §18).
 * An explicitly configured path wins; otherwise PATH is searched, honouring
 * PATHEXT on Windows.
 */
export async function findExecutable(
  command: string,
  options: {
    readonly configuredPath?: string | undefined;
    readonly env?: NodeJS.ProcessEnv;
  } = {},
): Promise<ExecutableLocation | null> {
  const env = options.env ?? process.env;

  if (options.configuredPath) {
    const candidate = resolve(options.configuredPath);
    return (await isExecutableFile(candidate))
      ? { path: candidate, source: "configured" }
      : null;
  }

  // A command containing a separator is a path, not a PATH lookup.
  if (command.includes("/") || command.includes("\\") || isAbsolute(command)) {
    const candidate = resolve(command);
    return (await isExecutableFile(candidate)) ? { path: candidate, source: "path" } : null;
  }

  const extensions =
    process.platform === "win32"
      ? (env["PATHEXT"] ?? ".EXE;.CMD;.BAT;.COM").split(";").filter(Boolean)
      : [""];

  for (const directory of (env["PATH"] ?? "").split(delimiter).filter(Boolean)) {
    for (const extension of extensions) {
      const candidate = join(directory, `${command}${extension}`);
      if (await isExecutableFile(candidate)) {
        return { path: candidate, source: "path" };
      }
    }
  }

  return null;
}

async function isExecutableFile(candidate: string): Promise<boolean> {
  try {
    const stats = await stat(candidate);
    if (!stats.isFile()) {
      return false;
    }
    if (process.platform === "win32") {
      return true;
    }
    await access(candidate, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export interface VersionProbe {
  readonly version: string | null;
  readonly raw: string;
  readonly ok: boolean;
}

/**
 * Asks a CLI for its version. A non-zero exit or unrecognizable output is
 * reported rather than thrown: an unusable provider must not break the app.
 */
export async function probeVersion(
  executablePath: string,
  args: string[] = ["--version"],
  timeoutMs = 5000,
): Promise<VersionProbe> {
  try {
    const { stdout, exit } = await execCli({
      executablePath,
      args,
      timeoutMs,
    });
    const raw = (stdout || exit.stderr).trim();
    return {
      ok: exit.code === 0,
      raw,
      version: extractVersion(raw),
    };
  } catch (error) {
    return {
      ok: false,
      raw: error instanceof Error ? error.message : String(error),
      version: null,
    };
  }
}

/**
 * Pulls a semver-ish number out of typical `--version` output. There is no
 * leading word boundary on purpose, so a "v"-prefixed version still matches.
 */
export function extractVersion(text: string): string | null {
  const match = /(\d+\.\d+(?:\.\d+)?(?:[-+][0-9A-Za-z.-]+)?)\b/.exec(text);
  return match?.[1] ?? null;
}
