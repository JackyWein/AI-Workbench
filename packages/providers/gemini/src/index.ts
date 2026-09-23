import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  cliProviderFactory,
  field,
  geminiProfile,
  listDirectory,
  parseProfile,
  poll,
  samePath,
  stringField,
  type CliExtensionContext,
  type CliInteractiveRun,
  type CliInteractiveTelemetry,
  type CliProviderExtensions,
} from "@ai-workbench/provider-cli";
import type { ProviderFactory } from "@ai-workbench/provider-base";
import type { TerminalMetrics } from "@ai-workbench/shared";

import {
  GEMINI_TRANSCRIPT_SOURCE,
  geminiHookTelemetry,
  islandIntegration,
  islandSetupArgs,
  metricsFromTranscript,
} from "./attention.js";
import { parseGeminiLine } from "./events.js";
import { geminiMcpLaunch } from "./mcp.js";

export * from "./attention.js";
export * from "./events.js";

/**
 * Gemini CLI records each chat under `~/.gemini/tmp/<project>/chats/`, where
 * the project folder holds a `.project_root` file naming the directory it
 * belongs to. Gemini CLI 0.60 writes `session-*.jsonl`, one record per line
 * (read by `metricsFromTranscript`, checked against real transcripts); older
 * releases wrote one `session-*.json` document, read by `metricsFromChat`.
 * With the island's extension installed, its hooks name the run's transcript
 * exactly; without it, the run's chat is the first one started with it.
 */

export const GEMINI_SESSION_SOURCE = GEMINI_TRANSCRIPT_SOURCE;

const POLL_MS = 3000;
const START_TOLERANCE_MS = 10_000;

function geminiHome(context: CliExtensionContext): string {
  return context.env["GEMINI_CLI_HOME"] ?? process.env["GEMINI_CLI_HOME"] ?? homedir();
}

/** The chats directory of the project that belongs to `workingDirectory`. */
async function chatsDirectory(root: string, workingDirectory: string): Promise<string | null> {
  for (const project of await listDirectory(root)) {
    const marker = join(root, project, ".project_root");
    try {
      const target = (await readFile(marker, "utf8")).trim();
      if (target && samePath(target, workingDirectory)) {
        return join(root, project, "chats");
      }
    } catch {
      // Not a project folder.
    }
  }
  return null;
}

/** Sums the token counts of a chat recorded as one JSON document. */
export function metricsFromChat(chat: unknown, at: Date): TerminalMetrics | null {
  const messages = field(chat, "messages");
  if (!Array.isArray(messages)) {
    return null;
  }
  const lines = messages.map((message) => JSON.stringify({ ...(message as object) }));
  const sessionId = stringField(chat, "sessionId");
  const metrics = metricsFromTranscript(
    [...(sessionId ? [JSON.stringify({ sessionId })] : []), ...lines].join("\n"),
    at,
  );
  return metrics;
}

/** The run's chat: started with it, the earliest such. */
async function findChat(root: string, run: CliInteractiveRun): Promise<string | null> {
  const chats = await chatsDirectory(root, run.workingDirectory);
  if (!chats) {
    return null;
  }
  const earliest = run.startedAt.getTime() - START_TOLERANCE_MS;
  const candidates: { path: string; at: number }[] = [];
  for (const entry of await listDirectory(chats)) {
    if (!entry.startsWith("session-") || !/\.jsonl?$/.test(entry)) {
      continue;
    }
    const path = join(chats, entry);
    const info = await stat(path).catch(() => null);
    if (info && info.birthtimeMs >= earliest) {
      candidates.push({ path, at: info.birthtimeMs });
    }
  }
  candidates.sort((a, b) => a.at - b.at);
  return candidates[0]?.path ?? null;
}

async function interactiveTelemetry(
  context: CliExtensionContext,
  run: CliInteractiveRun,
): Promise<CliInteractiveTelemetry | null> {
  const root = join(geminiHome(context), ".gemini", "tmp");
  const hooks = await geminiHookTelemetry(context, run);
  return {
    source: GEMINI_TRANSCRIPT_SOURCE,
    ...(hooks
      ? {
          env: hooks.env ?? {},
          ...(hooks.watchAttention ? { watchAttention: hooks.watchAttention } : {}),
          ...(hooks.watchActivity ? { watchActivity: hooks.watchActivity } : {}),
          ...(hooks.respond ? { respond: hooks.respond } : {}),
        }
      : {}),
    watch: (onMetrics) => {
      let found: string | null = null;
      let seen = 0;
      return poll(async () => {
        const file = hooks?.transcriptPath() ?? found ?? (found = await findChat(root, run));
        const info = file ? await stat(file).catch(() => null) : null;
        if (!file || !info || info.mtimeMs === seen) {
          return;
        }
        seen = info.mtimeMs;
        const text = await readFile(file, "utf8");
        const metrics = file.endsWith(".jsonl")
          ? metricsFromTranscript(text, new Date(info.mtimeMs))
          : metricsFromChat(safeJson(text), new Date(info.mtimeMs));
        if (metrics) {
          onMetrics(metrics);
        }
      }, POLL_MS);
    },
  };
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

/** What the Gemini CLI needs beyond its profile data. */
export const geminiExtensions: CliProviderExtensions = {
  interactiveTelemetry,
  mcpLaunch: geminiMcpLaunch,
  parseLine: parseGeminiLine,
  integration: { status: islandIntegration, setupArgs: islandSetupArgs },
};

export function geminiFactory(): ProviderFactory {
  return cliProviderFactory(parseProfile(geminiProfile), geminiExtensions);
}

export { geminiMcpLaunch, MCP_URL_ENV } from "./mcp.js";
