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
  ModelInfo,
  ProviderUsageSnapshot,
  TerminalMetrics,
  TerminalTokens,
  UsageLimit,
} from "@ai-workbench/shared";
import { parseOpencodeLine } from "./events.js";
import { mergeOpencodeModels, parseOpencodeModels } from "./models.js";
import { opencodeServerTelemetry, sessionMetrics } from "./server.js";
import { adaptOpencodeArgs, opencodeMajor } from "./version.js";

export * from "./events.js";
export * from "./models.js";
export * from "./server.js";
export * from "./version.js";

/**
 * What OpenCode needs beyond its profile data.
 *
 * Checked against OpenCode 1.18.32, the current npm release: the terminal
 * interface's own server (see server.ts), `run --format json` (events.ts),
 * `models` and `models --verbose` (models.ts) and the `stats` table. Two channels read
 * here were recorded by a contributor from OpenCode 2.0.13, which is not
 * published on npm, and are kept for it: `opencode api session.list` and
 * `opencode stats --json`. Neither exists in 1.18.32, so each is tried first
 * and given up quietly.
 */

export const OPENCODE_API_SOURCE = "OpenCode session API";

const POLL_MS = 5000;
const API_TIMEOUT_MS = 15_000;
/** A session created this long before the run cannot be the run's. */
const START_TOLERANCE_MS = 10_000;
/** `opencode api` failing this often in a row means this OpenCode has none. */
const API_ATTEMPTS = 2;

/**
 * OpenCode's commands, one at a time per entry. Two OpenCode processes that
 * start together in a fresh data directory both set up its database, and
 * one of them fails ("Failed query: CREATE TABLE ..."; measured with
 * 1.18.32). Asking in turn costs a second at most and never trips over that.
 */
const queues = new WeakMap<CliExtensionContext, Promise<unknown>>();

function exec(
  context: CliExtensionContext,
  args: string[],
  options: { readonly timeoutMs: number; readonly cwd?: string },
): Promise<{ stdout: string; exit: { code: number | null; stderr: string } }> {
  const previous = queues.get(context) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(() => context.exec(args, options));
  queues.set(context, next);
  return next;
}

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
  return sessionMetrics(session, OPENCODE_API_SOURCE, at);
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
  const { stdout, exit } = await exec(
    context,
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

/**
 * Session metrics through `opencode api`, for an OpenCode whose server does
 * not report them. Stops for good once the server has, or once the command
 * turns out not to exist.
 */
function apiMetrics(
  context: CliExtensionContext,
  run: CliInteractiveRun,
  onMetrics: (metrics: TerminalMetrics) => void,
  serverReported: () => boolean,
): () => void {
  let sessionId: string | null = null;
  let failures = 0;
  let stop: (() => void) | null = null;
  let stopped = false;
  const end = (): void => {
    stopped = true;
    stop?.();
  };
  stop = poll(async () => {
    if (stopped || serverReported() || failures >= API_ATTEMPTS) {
      end();
      return;
    }
    const sessions = await listSessions(context, run.workingDirectory);
    if (!sessions) {
      failures += 1;
      return;
    }
    failures = 0;
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
  if (stopped) {
    stop();
  }
  return end;
}

async function interactiveTelemetry(
  context: CliExtensionContext,
  run: CliInteractiveRun,
): Promise<CliInteractiveTelemetry | null> {
  // OpenCode 2's terminal interface has no server of its own to follow; it
  // talks to OpenCode's background service. Without live status it still
  // starts, rather than failing on flags it no longer has.
  const major = await opencodeMajor(context);
  if (major !== null && major >= 2) {
    return null;
  }
  const server = await opencodeServerTelemetry();
  if (!server) {
    return null;
  }
  return {
    ...server,
    source: "OpenCode server",
    watch: (onMetrics) => {
      let fromServer = false;
      const stopServer = server.watch((metrics) => {
        fromServer = true;
        onMetrics(metrics);
      });
      const stopApi = apiMetrics(context, run, onMetrics, () => fromServer);
      return () => {
        stopServer();
        stopApi();
      };
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

/** "120", "12.3K" or "1.2M", as the stats table prints token counts. */
function tableNumber(text: string): number | undefined {
  const match = /^\$?([\d.,]+)([KM])?$/.exec(text.trim());
  if (!match) {
    return undefined;
  }
  const value = Number((match[1] ?? "").replace(/,/g, ""));
  if (!Number.isFinite(value)) {
    return undefined;
  }
  const scale = match[2] === "M" ? 1_000_000 : match[2] === "K" ? 1000 : 1;
  return Math.round(value * scale);
}

/**
 * The totals of the `opencode stats` table, in the shape of its JSON answer.
 * The table rounds tokens to a tenth of a thousand or million and cost to
 * cents; that is what the tool says, so that is what is shown.
 */
export function parseStatsTable(stdout: string): unknown {
  const rows = new Map<string, string>();
  for (const line of stdout.split("\n")) {
    const match = /^[│|]\s*([A-Za-z/ ]+?)\s{2,}(\S+)\s*[│|]\s*$/.exec(line.trim());
    if (match?.[1] && match[2]) {
      rows.set(match[1].trim(), match[2]);
    }
  }
  const input = tableNumber(rows.get("Input") ?? "");
  const output = tableNumber(rows.get("Output") ?? "");
  const cost = rows.get("Total Cost");
  if (input === undefined || output === undefined) {
    return null;
  }
  const costValue = cost?.startsWith("$") ? Number(cost.slice(1).replace(/,/g, "")) : undefined;
  return {
    tokens: {
      input,
      output,
      cache: {
        read: tableNumber(rows.get("Cache Read") ?? "") ?? 0,
        write: tableNumber(rows.get("Cache Write") ?? "") ?? 0,
      },
    },
    ...(costValue !== undefined && Number.isFinite(costValue) ? { cost: costValue } : {}),
  };
}

/**
 * `--days 0` counts since local midnight and `--days 7` the last seven days,
 * as OpenCode's own stats code defines them.
 */
async function readStats(context: CliExtensionContext, days: number): Promise<unknown> {
  const json = await exec(context, ["stats", "--json", "--days", String(days)], {
    timeoutMs: 30_000,
  });
  if (json.exit.code === 0) {
    try {
      return JSON.parse(json.stdout) as unknown;
    } catch {
      // Not JSON after all; the table below says the same.
    }
  }
  const table = await exec(context, ["stats", "--days", String(days)], { timeoutMs: 30_000 });
  return table.exit.code === 0 ? parseStatsTable(table.stdout) : null;
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

/** Every model OpenCode can reach, with names, context sizes and efforts. */
async function discoverModels(context: CliExtensionContext): Promise<ModelInfo[] | null> {
  let plain = await exec(context, ["models"], { timeoutMs: 60_000 });
  if (plain.exit.code !== 0) {
    // Once more, in case another OpenCode process was setting up its data.
    plain = await exec(context, ["models"], { timeoutMs: 60_000 });
  }
  const verbose = await exec(context, ["models", "--verbose"], { timeoutMs: 60_000 });
  const details = verbose.exit.code === 0 ? parseOpencodeModels(verbose.stdout) : [];
  if (plain.exit.code !== 0) {
    if (details.length > 0) {
      return details;
    }
    const said = (plain.exit.stderr || plain.stdout).trim().split("\n")[0];
    throw new Error(said ? `\`opencode models\` failed: ${said}` : "`opencode models` failed");
  }
  return mergeOpencodeModels(parseOpencodeModels(plain.stdout), details);
}

/** What OpenCode needs beyond its profile data. */
export const opencodeExtensions: CliProviderExtensions = {
  adaptArgs: adaptOpencodeArgs,
  discoverModels,
  readUsage,
  interactiveTelemetry,
  parseLine: parseOpencodeLine,
};

export function opencodeFactory(): ProviderFactory {
  return cliProviderFactory(parseProfile(opencodeProfile), opencodeExtensions);
}
