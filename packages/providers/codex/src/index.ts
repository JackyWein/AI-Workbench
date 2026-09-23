import {
  cliProviderFactory,
  parseProfile,
  type CliExtensionContext,
  type CliProviderExtensions,
} from "@ai-workbench/provider-cli";
import type { ProviderFactory } from "@ai-workbench/provider-base";
import { probeAppServer, type CodexProbe } from "./app-server.js";
import { codexHookTelemetry } from "./attention.js";
import { toAuthStatus } from "./auth.js";
import { parseCodexLine } from "./events.js";
import { toModelInfos } from "./models.js";
import { codexProfile } from "./profile.js";
import { readRolloutUsage, rolloutTelemetry, sessionsRoot } from "./rollout.js";
import { toUsageSnapshot } from "./usage.js";

export { codexProfile, codexNotice } from "./profile.js";
export * from "./rollout.js";
export * from "./attention.js";
export { toUsageSnapshot, windowLabel } from "./usage.js";

/** One app server answers models, account and limits; asked at most this often. */
const PROBE_TTL_MS = 60_000;

const probes = new WeakMap<CliExtensionContext, { at: number; probe: Promise<CodexProbe> }>();

/** The app server's answers for this entry, shared by the hooks that need them. */
function probe(context: CliExtensionContext): Promise<CodexProbe> {
  const cached = probes.get(context);
  if (cached && Date.now() - cached.at < PROBE_TTL_MS) {
    return cached.probe;
  }
  const next = probeAppServer(context);
  probes.set(context, { at: Date.now(), probe: next });
  return next;
}

/**
 * What Codex needs beyond its profile data. Everything the app server cannot
 * answer — an older CLI has none — falls back to the tool's own session logs,
 * and from there to "unavailable"; nothing is guessed.
 */
export const codexExtensions: CliProviderExtensions = {
  discoverModels: async (context) => {
    const { models } = await probe(context);
    return models ? toModelInfos(models) : null;
  },
  probeAuth: async (context) => {
    const { account } = await probe(context);
    return account ? toAuthStatus(account) : null;
  },
  readUsage: async (context) => {
    const { rateLimits } = await probe(context);
    if (rateLimits) {
      const snapshot = toUsageSnapshot(rateLimits, context.providerId);
      if (snapshot.state !== "unavailable") {
        return snapshot;
      }
    }
    return readRolloutUsage(sessionsRoot(context), context.providerId);
  },
  parseLine: parseCodexLine,
  // Numbers from its session log; waiting and working from its hooks.
  interactiveTelemetry: async (context, run) => {
    const [rollout, hooks] = await Promise.all([
      rolloutTelemetry(context, run),
      codexHookTelemetry(context, run),
    ]);
    if (!rollout || !hooks) {
      return rollout;
    }
    return {
      ...rollout,
      ...hooks,
      args: [...(rollout.args ?? []), ...(hooks.args ?? [])],
      env: { ...rollout.env, ...hooks.env },
    };
  },
};

/** Codex's entries: the default account and any further ones. */
export function codexFactory(): ProviderFactory {
  return cliProviderFactory(parseProfile(codexProfile), codexExtensions);
}
