import { existsSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { ProviderFactory } from "@ai-workbench/provider-base";
import { expandPath } from "@ai-workbench/transport-cli";
import { CliProviderAdapter } from "./adapter.js";
import type { CliProviderExtensions } from "./extensions.js";
import { listDirectory, samePath } from "./follow.js";
import type { CliAccounts, CliProviderProfile } from "./profile.js";

/**
 * The entries of one CLI tool: its default entry, and one per account when
 * the tool keeps several side by side (spec §39). Everything tool-specific is
 * the profile's data and the extensions its package hands in.
 */
export function cliProviderFactory(
  profile: CliProviderProfile,
  extensions?: CliProviderExtensions,
): ProviderFactory {
  const accounts = profile.accounts;
  return {
    family: profile.id,
    displayName: profile.displayName,
    ...(accounts
      ? {
          accounts: {
            detect: () => detectHomes(accounts),
            isDefaultHome: (home: string) => {
              const defaultHome = expandPath(accounts.defaultHome);
              return defaultHome !== null && samePath(home, defaultHome);
            },
          },
        }
      : {}),
    create: (account) =>
      new CliProviderAdapter(profile, {
        ...(extensions ? { extensions } : {}),
        ...(account ? { account } : {}),
      }),
  };
}

/**
 * Removes the variables the given tools use to mark their own child
 * processes, so a run started by the application is a top-level session even
 * when the application was launched from inside one of those tools.
 */
export function scrubHostEnvironment(
  profiles: readonly CliProviderProfile[],
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const removed: string[] = [];
  for (const name of profiles.flatMap((profile) => profile.hostEnvUnset)) {
    if (env[name] !== undefined) {
      delete env[name];
      removed.push(name);
    }
  }
  return removed;
}

/**
 * Further configuration homes that already exist, e.g. `~/.claude-work`. A
 * directory only counts when it holds one of the profile's marker files, so a
 * stray folder is never offered as an account.
 */
async function detectHomes(accounts: CliAccounts): Promise<string[]> {
  const found: string[] = [];
  for (const pattern of accounts.detect) {
    const expanded = expandPath(pattern);
    if (!expanded) {
      continue;
    }
    const parent = dirname(expanded);
    const matcher = globToRegExp(basename(expanded));
    for (const entry of await listDirectory(parent)) {
      if (!matcher.test(entry)) {
        continue;
      }
      const home = join(parent, entry);
      if (
        accounts.markers.length === 0 ||
        accounts.markers.some((marker) => existsSync(join(home, marker)))
      ) {
        found.push(home);
      }
    }
  }
  return found;
}

function globToRegExp(segment: string): RegExp {
  const escaped = segment.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".+");
  return new RegExp(`^${escaped}$`, "i");
}
