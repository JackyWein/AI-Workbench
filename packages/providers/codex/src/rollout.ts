import { open, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  JsonLinesFollower,
  field,
  listDirectory,
  numberField,
  poll,
  samePath,
  stringField,
  type CliExtensionContext,
  type CliInteractiveRun,
  type CliInteractiveTelemetry,
} from "@ai-workbench/provider-cli";
import type {
  ProviderUsageSnapshot,
  TerminalMetrics,
  TerminalTokens,
} from "@ai-workbench/shared";
import type { RateLimitWindow, RateLimitsResponse } from "./app-server.js";
import { toUsageSnapshot } from "./usage.js";

/**
 * Codex writes every session to a "rollout": one JSON line per event under
 * `<CODEX_HOME>/sessions/YYYY/MM/DD/rollout-<time>-<id>.jsonl`. Among the
 * events are `token_count` reports carrying the session's token totals, the
 * context window, and the account's rate limits exactly as the backend sent
 * them. Reading them spends nothing and needs no sign-in of our own.
 *
 * Shapes were checked against rollouts of Codex 0.155.
 */

export const ROLLOUT_SOURCE = "Codex session log";

const POLL_MS = 1500;
/** How much of a rollout's end is read when looking for the latest limits. */
const TAIL_BYTES = 512 * 1024;
/** The first line holds the session's instructions and may be long. */
const HEAD_BYTES = 256 * 1024;
/** Rollouts looked at when reading account usage. */
const RECENT_ROLLOUTS = 12;
/** A rollout that started this long before the run cannot be the run's. */
const START_TOLERANCE_MS = 30_000;

/** Rollouts claimed by a running terminal; a second terminal must not take one. */
const claimed = new Set<string>();

/** Where this entry's tool keeps its sessions. */
export function sessionsRoot(context: CliExtensionContext): string {
  const home =
    context.accountHome ??
    context.env["CODEX_HOME"] ??
    process.env["CODEX_HOME"] ??
    join(homedir(), ".codex");
  return join(home, "sessions");
}

/** Rollout files, newest first, from the most recent day directories. */
export async function recentRollouts(root: string, limit: number): Promise<string[]> {
  const found: string[] = [];
  const descending = (entries: string[]): string[] =>
    entries.filter((entry) => /^\d+$/.test(entry)).sort((a, b) => Number(b) - Number(a));
  for (const year of descending(await listDirectory(root))) {
    for (const month of descending(await listDirectory(join(root, year)))) {
      for (const day of descending(await listDirectory(join(root, year, month)))) {
        const directory = join(root, year, month, day);
        const files = (await listDirectory(directory))
          .filter((entry) => entry.startsWith("rollout-") && entry.endsWith(".jsonl"))
          .sort()
          .reverse();
        for (const file of files) {
          found.push(join(directory, file));
          if (found.length >= limit) {
            return found;
          }
        }
      }
    }
  }
  return found;
}

/** The rate limits of a `token_count` payload, in the app server's shape. */
export function rateLimitsOf(payload: unknown): RateLimitsResponse | null {
  const limits = field(payload, "rate_limits");
  if (typeof limits !== "object" || limits === null) {
    return null;
  }
  const window = (slot: "primary" | "secondary"): RateLimitWindow | null => {
    const usedPercent = numberField(limits, slot, "used_percent");
    if (usedPercent === undefined) {
      return null;
    }
    return {
      usedPercent,
      windowDurationMins: numberField(limits, slot, "window_minutes") ?? null,
      resetsAt: numberField(limits, slot, "resets_at") ?? null,
    };
  };
  const primary = window("primary");
  const secondary = window("secondary");
  if (!primary && !secondary) {
    return null;
  }
  return {
    rateLimits: {
      limitId: stringField(limits, "limit_id") ?? null,
      limitName: stringField(limits, "limit_name") ?? null,
      primary,
      secondary,
      planType: stringField(limits, "plan_type") ?? null,
      rateLimitReachedType: stringField(limits, "rate_limit_reached_type") ?? null,
    },
  };
}

/** A token_count event's payload, or undefined when the record is another event. */
function tokenCountOf(record: unknown): unknown {
  if (stringField(record, "type") !== "event_msg") {
    return undefined;
  }
  const payload = field(record, "payload");
  return stringField(payload, "type") === "token_count" ? payload : undefined;
}

async function readRange(path: string, start: number, length: number): Promise<string> {
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, start);
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    await handle.close();
  }
}

function parseLines(text: string): unknown[] {
  return text.split("\n").flatMap((line) => {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) {
      return [];
    }
    try {
      const record: unknown = JSON.parse(trimmed);
      return [record];
    } catch {
      return [];
    }
  });
}

/**
 * The account usage Codex last reported in any session on this machine.
 * The snapshot keeps the time of that report, so the person sees its age.
 */
export async function readRolloutUsage(
  root: string,
  providerId: string,
): Promise<ProviderUsageSnapshot | null> {
  let newest: { at: Date; response: RateLimitsResponse } | null = null;
  for (const path of await recentRollouts(root, RECENT_ROLLOUTS)) {
    let size: number;
    try {
      size = (await stat(path)).size;
    } catch {
      continue;
    }
    const start = Math.max(0, size - TAIL_BYTES);
    const records = parseLines(await readRange(path, start, size - start));
    for (let index = records.length - 1; index >= 0; index -= 1) {
      const record = records[index];
      const response = rateLimitsOf(tokenCountOf(record));
      const at = Date.parse(stringField(record, "timestamp") ?? "");
      if (response && Number.isFinite(at)) {
        if (!newest || newest.at.getTime() < at) {
          newest = { at: new Date(at), response };
        }
        break;
      }
    }
  }
  if (!newest) {
    return null;
  }
  const snapshot = toUsageSnapshot(newest.response, providerId, newest.at);
  return snapshot.state === "unavailable" ? null : snapshot;
}

/** The first record of a rollout: the session it belongs to. */
async function sessionMetaOf(path: string): Promise<unknown> {
  const head = await readRange(path, 0, HEAD_BYTES);
  const firstLine = head.split("\n")[0] ?? "";
  try {
    const record: unknown = JSON.parse(firstLine);
    return stringField(record, "type") === "session_meta" ? field(record, "payload") : undefined;
  } catch {
    return undefined;
  }
}

/** Day directories a run that started at `at` may have written into. */
function dayDirectories(root: string, at: Date): string[] {
  const days = [at, new Date(at.getTime() + 24 * 60 * 60 * 1000)];
  return days.map((day) =>
    join(
      root,
      String(day.getFullYear()),
      String(day.getMonth() + 1).padStart(2, "0"),
      String(day.getDate()).padStart(2, "0"),
    ),
  );
}

/** Finds the rollout the run is writing: same directory, started with it. */
async function findRollout(root: string, run: CliInteractiveRun): Promise<string | null> {
  const earliest = run.startedAt.getTime() - START_TOLERANCE_MS;
  const candidates: { path: string; startedAt: number }[] = [];
  for (const directory of dayDirectories(root, run.startedAt)) {
    for (const entry of await listDirectory(directory)) {
      const path = join(directory, entry);
      if (!entry.endsWith(".jsonl") || claimed.has(path)) {
        continue;
      }
      try {
        if ((await stat(path)).mtimeMs < earliest) {
          continue;
        }
      } catch {
        continue;
      }
      const meta = await sessionMetaOf(path);
      const cwd = stringField(meta, "cwd");
      const startedAt = Date.parse(stringField(meta, "timestamp") ?? "");
      if (cwd && samePath(cwd, run.workingDirectory) && startedAt >= earliest) {
        candidates.push({ path, startedAt });
      }
    }
  }
  candidates.sort((a, b) => a.startedAt - b.startedAt);
  return candidates[0]?.path ?? null;
}

/** What the rollout said so far about its session. */
interface RolloutState {
  sessionId?: string;
  model?: string;
  tokens?: TerminalTokens;
  context?: TerminalMetrics["context"];
  limits: TerminalMetrics["limits"];
  at?: Date;
}

/** Applies one rollout record; true when something visible changed. */
export function applyRolloutRecord(state: RolloutState, record: unknown, providerId: string): boolean {
  const type = stringField(record, "type");
  const payload = field(record, "payload");
  const at = Date.parse(stringField(record, "timestamp") ?? "");
  if (type === "session_meta") {
    const id = stringField(payload, "id") ?? stringField(payload, "session_id");
    if (id && id !== state.sessionId) {
      state.sessionId = id;
      return true;
    }
    return false;
  }
  if (type === "turn_context") {
    const model = stringField(payload, "model");
    if (model && model !== state.model) {
      state.model = model;
      return true;
    }
    return false;
  }
  const count = tokenCountOf(record);
  if (count === undefined) {
    return false;
  }
  const total = field(count, "info", "total_token_usage");
  const input = numberField(total, "input_tokens");
  const output = numberField(total, "output_tokens");
  if (input !== undefined && output !== undefined) {
    const cached = numberField(total, "cached_input_tokens") ?? 0;
    const reasoning = numberField(total, "reasoning_output_tokens");
    state.tokens = {
      // Codex counts cached input as part of the input; shown apart here.
      input: Math.max(0, input - cached),
      output,
      cacheRead: cached,
      ...(reasoning === undefined ? {} : { reasoning }),
    };
  }
  const contextUsed = numberField(count, "info", "last_token_usage", "total_tokens");
  const contextWindow = numberField(count, "info", "model_context_window");
  if (contextUsed !== undefined) {
    state.context = {
      usedTokens: contextUsed,
      ...(contextWindow === undefined || contextWindow <= 0 ? {} : { windowTokens: contextWindow }),
    };
  }
  const response = rateLimitsOf(count);
  if (response) {
    state.limits = toUsageSnapshot(response, providerId).limits;
  }
  if (Number.isFinite(at)) {
    state.at = new Date(at);
  }
  return true;
}

/** Follows the rollout an interactive Codex run writes. */
export async function rolloutTelemetry(
  context: CliExtensionContext,
  run: CliInteractiveRun,
): Promise<CliInteractiveTelemetry | null> {
  const root = sessionsRoot(context);
  return {
    source: ROLLOUT_SOURCE,
    watch: (onMetrics) => {
      let follower: JsonLinesFollower | null = null;
      const state: RolloutState = { limits: [] };
      const stop = poll(async () => {
        if (!follower) {
          const path = await findRollout(root, run);
          if (!path) {
            return;
          }
          claimed.add(path);
          follower = new JsonLinesFollower(path);
        }
        let changed = false;
        for (const record of await follower.readNew()) {
          changed = applyRolloutRecord(state, record, context.providerId) || changed;
        }
        if (changed && (state.tokens || state.limits.length > 0 || state.model)) {
          onMetrics({
            source: ROLLOUT_SOURCE,
            ...(state.sessionId === undefined ? {} : { providerSessionId: state.sessionId }),
            ...(state.model === undefined ? {} : { model: state.model }),
            ...(state.tokens === undefined ? {} : { tokens: state.tokens }),
            ...(state.context === undefined ? {} : { context: state.context }),
            limits: state.limits,
            updatedAt: state.at ?? new Date(),
          });
        }
      }, POLL_MS);
      return () => {
        stop();
        if (follower) {
          claimed.delete(follower.path);
        }
      };
    },
  };
}
