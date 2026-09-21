import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

/**
 * Expands `~`, `%VAR%` and `$VAR` / `${VAR}` in a configured location.
 * Returns null when a variable the path depends on is not set, so a location
 * for another platform is skipped instead of resolving somewhere unintended.
 */
export function expandPath(
  pattern: string,
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): string | null {
  let missing = false;
  const lookup = (name: string): string => {
    const value = env[name] ?? findCaseInsensitive(env, name);
    if (value === undefined || value === "") {
      missing = true;
      return "";
    }
    return value;
  };

  let expanded = pattern.replace(/%([A-Za-z_][A-Za-z0-9_]*)%/g, (_match, name: string) =>
    lookup(name),
  );
  expanded = expanded.replace(
    /\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))/g,
    (_match, braced: string | undefined, bare: string | undefined) =>
      lookup(braced ?? bare ?? ""),
  );
  if (expanded === "~" || expanded.startsWith("~/") || expanded.startsWith("~\\")) {
    expanded = join(home, expanded.slice(1));
  }
  return missing ? null : expanded;
}

/** Windows variables are case-insensitive; a copied environment may not be. */
function findCaseInsensitive(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(env)) {
    if (key.toLowerCase() === wanted) {
      return value;
    }
  }
  return undefined;
}

/**
 * Lists existing directories matching a pattern whose last segment may hold
 * one `*`, e.g. `~/.tool-*`. Nothing else is a wildcard, and nothing outside the
 * parent directory is ever read.
 */
export async function matchDirectories(
  pattern: string,
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): Promise<string[]> {
  const expanded = expandPath(pattern, env, home);
  if (expanded === null) {
    return [];
  }

  const leaf = basename(expanded);
  const parent = dirname(expanded);
  if (!leaf.includes("*")) {
    return (await isDirectory(expanded)) ? [expanded] : [];
  }

  const [prefix = "", suffix = ""] = leaf.split("*", 2);
  let names: string[];
  try {
    names = await readdir(parent);
  } catch {
    return [];
  }

  const matches: string[] = [];
  for (const name of names.sort()) {
    if (
      name.length > prefix.length + suffix.length &&
      name.startsWith(prefix) &&
      name.endsWith(suffix)
    ) {
      const candidate = join(parent, name);
      if (await isDirectory(candidate)) {
        matches.push(candidate);
      }
    }
  }
  return matches;
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}
