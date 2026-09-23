import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  cliProviderFactory,
  field,
  geminiProfile,
  listDirectory,
  numberField,
  parseProfile,
  poll,
  readJsonFile,
  samePath,
  stringField,
  type CliExtensionContext,
  type CliInteractiveRun,
  type CliInteractiveTelemetry,
  type CliProviderExtensions,
} from "@ai-workbench/provider-cli";
import type { ProviderFactory } from "@ai-workbench/provider-base";
import type { TerminalMetrics, TerminalTokens } from "@ai-workbench/shared";

/**
 * Gemini CLI records each chat as a JSON file under
 * `~/.gemini/tmp/<project>/chats/session-*.json`, where the project folder
 * holds a `.project_root` file naming the directory it belongs to. Messages
 * the model answered carry the token counts the API returned.
 *
 * Unverified: no recorded session was available to check the shape against,
 * so every field is read defensively and a file that does not match simply
 * yields nothing.
 */

export const GEMINI_SESSION_SOURCE = "Gemini CLI session file (unverified)";

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

/** Sums the token counts of a recorded chat. */
export function metricsFromChat(chat: unknown, at: Date): TerminalMetrics | null {
  const messages = field(chat, "messages");
  if (!Array.isArray(messages)) {
    return null;
  }
  let model: string | undefined;
  const tokens: Required<Pick<TerminalTokens, "input" | "output" | "cacheRead" | "reasoning">> = {
    input: 0,
    output: 0,
    cacheRead: 0,
    reasoning: 0,
  };
  let counted = false;
  for (const message of messages) {
    const input = numberField(message, "tokens", "input");
    const output = numberField(message, "tokens", "output");
    if (input === undefined || output === undefined) {
      continue;
    }
    counted = true;
    const cached = numberField(message, "tokens", "cached") ?? 0;
    tokens.input += Math.max(0, input - cached);
    tokens.cacheRead += cached;
    tokens.output += output;
    tokens.reasoning += numberField(message, "tokens", "thoughts") ?? 0;
    model = stringField(message, "model") ?? model;
  }
  if (!counted) {
    return null;
  }
  const sessionId = stringField(chat, "sessionId");
  return {
    source: GEMINI_SESSION_SOURCE,
    ...(sessionId === undefined ? {} : { providerSessionId: sessionId }),
    ...(model === undefined ? {} : { model }),
    tokens,
    limits: [],
    updatedAt: at,
  };
}

async function interactiveTelemetry(
  context: CliExtensionContext,
  run: CliInteractiveRun,
): Promise<CliInteractiveTelemetry | null> {
  const root = join(geminiHome(context), ".gemini", "tmp");
  const earliest = run.startedAt.getTime() - START_TOLERANCE_MS;
  return {
    source: GEMINI_SESSION_SOURCE,
    watch: (onMetrics) => {
      let file: string | null = null;
      let seen = 0;
      return poll(async () => {
        if (!file) {
          const chats = await chatsDirectory(root, run.workingDirectory);
          if (!chats) {
            return;
          }
          const candidates: { path: string; at: number }[] = [];
          for (const entry of await listDirectory(chats)) {
            if (!entry.startsWith("session-") || !entry.endsWith(".json")) {
              continue;
            }
            const path = join(chats, entry);
            const info = await stat(path).catch(() => null);
            if (info && info.birthtimeMs >= earliest) {
              candidates.push({ path, at: info.birthtimeMs });
            }
          }
          candidates.sort((a, b) => a.at - b.at);
          file = candidates[0]?.path ?? null;
          if (!file) {
            return;
          }
        }
        const info = await stat(file).catch(() => null);
        if (!info || info.mtimeMs === seen) {
          return;
        }
        seen = info.mtimeMs;
        const metrics = metricsFromChat(await readJsonFile(file), new Date(info.mtimeMs));
        if (metrics) {
          onMetrics(metrics);
        }
      }, POLL_MS);
    },
  };
}

/** What the Gemini CLI needs beyond its profile data. */
export const geminiExtensions: CliProviderExtensions = {
  interactiveTelemetry,
};

export function geminiFactory(): ProviderFactory {
  return cliProviderFactory(parseProfile(geminiProfile), geminiExtensions);
}
