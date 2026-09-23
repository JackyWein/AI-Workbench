import type { Logger } from "@ai-workbench/shared";
import type { CliTransport } from "@ai-workbench/transport-cli";
import type { CliExtensionContext } from "./extensions.js";
import type { CliProviderProfile } from "./profile.js";

export interface ExtensionContextInput {
  readonly profile: CliProviderProfile;
  readonly providerId: string;
  readonly logger: Logger;
  readonly stateDirectory: string;
  readonly env: Readonly<Record<string, string>>;
  readonly accountHome: string | null;
  readonly transport: CliTransport;
  /** The installed version as detection read it; shared, not probed again. */
  readonly version: () => Promise<string | null>;
}

/**
 * Everything an extension may do goes through the entry's own transport, so a
 * probe runs the same executable, with the same account environment and the
 * same configured arguments, as a turn does — and never through a shell.
 */
export function createExtensionContext(input: ExtensionContextInput): CliExtensionContext {
  const { transport } = input;
  return {
    profile: input.profile,
    providerId: input.providerId,
    logger: input.logger,
    stateDirectory: input.stateDirectory,
    env: input.env,
    accountHome: input.accountHome,
    locate: () => transport.locate(),
    version: input.version,
    exec: (args, options) => transport.exec({ args, ...options }),
    start: (args, options) => transport.start({ args, ...options }),
  };
}

const TIMED_OUT: unique symbol = Symbol("timed out");

/**
 * Runs one extension hook with its failure contained (spec §60): a throw, a
 * rejection or no answer within `timeoutMs` is logged and becomes null, which
 * every caller already treats as "the tool could not say".
 */
export async function runHook<T>(
  logger: Logger,
  hook: string,
  timeoutMs: number,
  run: () => Promise<T | null>,
): Promise<T | null> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), timeoutMs);
    timer.unref?.();
  });
  try {
    const result = await Promise.race([run(), timeout]);
    if (result === TIMED_OUT) {
      logger.warn("Provider extension did not answer in time", { hook, timeoutMs });
      return null;
    }
    return result;
  } catch (error) {
    logger.warn("Provider extension failed", {
      hook,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  } finally {
    clearTimeout(timer);
  }
}
