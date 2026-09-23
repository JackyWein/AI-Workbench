import {
  cliProviderFactory,
  field,
  numberField,
  opencodeProfile,
  parseProfile,
  poll,
  stringField,
  type CliExtensionContext,
  type CliInteractiveRun,
  type CliInteractiveTelemetry,
  type CliProviderExtensions,
} from "@ai-workbench/provider-cli";
import type { ProviderFactory } from "@ai-workbench/provider-base";
import type {
  ProviderUsageSnapshot,
  TerminalMetrics,
  TerminalTokens,
  UsageLimit,
} from "@ai-workbench/shared";

/**
 * OpenCode runs a background service that its terminal interface, `run` and
 * `stats` all talk to. `opencode api` makes an authenticated request to that
 * service, so session totals — tokens and cost per session, as OpenCode keeps
 * them — are read through the tool itself, with no credentials of our own.
 *
 * Checked against OpenCode 2.0.13.
 */

export const OPENCODE_API_SOURCE = "OpenCode session API";

const POLL_MS = 5000;
const API_TIMEOUT_MS = 15_000;
/** A session created this long before the run cannot be the run's. */
const START_TOLERANCE_MS = 10_000;

/** Token totals of an OpenCode session or stats answer. */
export function tokensOf(value: unknown): TerminalTokens | undefined {
  const input = numberField(value, "tokens", "input");
  const output = numberField(value, "tokens", "output");
  if (input === undefined || output === undefined) {
    return undefined;
  }
  const reasoning = numberField(value, "tokens", "reasoning");
  const cacheRead = numberField(value, "tokens", "cache", "read");
  const cacheWrite = numberField(value, "tokens", "cache", "write");
  return {
    input,
    output,
    ...(reasoning === undefined ? {} : { reasoning }),
    ...(cacheRead === undefined ? {} : { cacheRead }),
    ...(cacheWrite === undefined ? {} : { cacheWrite }),
  };
}

/** Metrics for one session record of `session.list`. */
export function metricsFromSession(session: unknown, at: Date): TerminalMetrics | null {
  const id = stringField(session, "id");
  if (!id) {
    return null;
  }
  const model = stringField(session, "model", "id");
  const tokens = tokensOf(session);
  const cost = numberField(session, "cost");
  return {
    source: OPENCODE_API_SOURCE,
    providerSessionId: id,
    ...(model === undefined ? {} : { model }),
    ...(tokens === undefined ? {} : { tokens }),
    // OpenCode prices the tokens itself from its model catalogue.
    ...(cost === undefined ? {} : { costUsd: cost, costEstimated: true }),
    limits: [],
    updatedAt: at,
  };
}

/** The session list of `opencode api session.list`, or null when unreadable. */
export function parseSessionList(stdout: string): unknown[] | null {
  try {
    const parsed: unknown = JSON.parse(stdout);
    const data = field(parsed, "data");
    return Array.isArray(data) ? data : null;
  } catch {
    return null;
  }
}

/** The run's session: in its directory, created with it, the earliest such. */
export function pickRunSession(sessions: readonly unknown[], startedAt: Date): unknown {
  const earliest = startedAt.getTime() - START_TOLERANCE_MS;
  return sessions
    .filter((session) => (numberField(session, "time", "created") ?? 0) >= earliest)
    .sort(
      (a, b) => (numberField(a, "time", "created") ?? 0) - (numberField(b, "time", "created") ?? 0),
    )[0];
}

async function listSessions(
  context: CliExtensionContext,
  directory: string,
): Promise<unknown[] | null> {
  const { stdout, exit } = await context.exec(
    [
      "api",
      "session.list",
      "--param",
      `directory=${directory}`,
      "--param",
      "parentID=null",
      "--param",
      "limit=10",
    ],
    { timeoutMs: API_TIMEOUT_MS, cwd: directory },
  );
  return exit.code === 0 ? parseSessionList(stdout) : null;
}

async function interactiveTelemetry(
  context: CliExtensionContext,
  run: CliInteractiveRun,
): Promise<CliInteractiveTelemetry | null> {
  return {
    source: OPENCODE_API_SOURCE,
    watch: (onMetrics) => {
      let sessionId: string | null = null;
      return poll(async () => {
        const sessions = await listSessions(context, run.workingDirectory);
        if (!sessions) {
          return;
        }
        const session = sessionId
          ? sessions.find((entry) => stringField(entry, "id") === sessionId)
          : pickRunSession(sessions, run.startedAt);
        const id = stringField(session, "id");
        if (!id) {
          return;
        }
        sessionId = id;
        const updated = numberField(session, "time", "updated");
        const metrics = metricsFromSession(session, updated ? new Date(updated) : new Date());
        if (metrics) {
          onMetrics(metrics);
        }
      }, POLL_MS);
    },
  };
}

/** Today's and the last seven days' totals from `opencode stats`. */
export function statsLimits(today: unknown, week: unknown): UsageLimit[] {
  const limits: UsageLimit[] = [];
  const add = (stats: unknown, key: string, label: string): void => {
    const tokens = tokensOf(stats);
    if (tokens) {
      limits.push({
        id: `${key}.tokens`,
        label: `Tokens ${label}`,
        used: tokens.input + tokens.output + (tokens.reasoning ?? 0),
        unit: "tokens",
      });
    }
    const cost = numberField(stats, "cost");
    if (cost !== undefined) {
      limits.push({ id: `${key}.cost`, label: `Cost ${label}`, used: cost, unit: "usd" });
    }
  };
  add(today, "today", "today");
  add(week, "week", "· 7 days");
  return limits;
}

async function readStats(context: CliExtensionContext, days: number): Promise<unknown> {
  const { stdout, exit } = await context.exec(["stats", "--json", "--days", String(days)], {
    timeoutMs: 30_000,
  });
  if (exit.code !== 0) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(stdout);
    return parsed;
  } catch {
    return null;
  }
}

async function readUsage(context: CliExtensionContext): Promise<ProviderUsageSnapshot | null> {
  const [today, week] = await Promise.all([readStats(context, 0), readStats(context, 7)]);
  const limits = statsLimits(today, week);
  if (limits.length === 0) {
    return null;
  }
  return {
    providerId: context.providerId,
    state: "available",
    limits,
    updatedAt: new Date(),
    source: "cli",
    note: "OpenCode has no quota; these are the amounts used.",
  };
}

/** What OpenCode needs beyond its profile data. */
export const opencodeExtensions: CliProviderExtensions = {
  readUsage,
  interactiveTelemetry,
};

export function opencodeFactory(): ProviderFactory {
  return cliProviderFactory(parseProfile(opencodeProfile), opencodeExtensions);
}
