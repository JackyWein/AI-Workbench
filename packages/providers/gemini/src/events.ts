import type { ProviderEvent, ToolCallRecord } from "@ai-workbench/shared";
import { field, numberField, stringField, type CliParseState } from "@ai-workbench/provider-cli";

/**
 * Decodes `gemini --prompt ... --output-format stream-json` (spec §13).
 *
 * Recorded from Gemini CLI 0.60 against a stand-in for the Gemini API:
 *
 * - `init` names the session (`session_id`), which `--resume` continues.
 * - `message` with role "assistant" carries answer text, `delta: true` for a
 *   piece of it; the prompt comes back as role "user" and is skipped.
 * - `tool_use` (`tool_name`, `tool_id`, `parameters`) and later
 *   `tool_result` (`tool_id`, `status`, `output`) describe one tool call.
 * - `result` closes the turn with `status` and `stats`: tokens for the whole
 *   turn, cached input and its duration.
 * - `error` carries a `message`.
 */

/** Tool output kept per call: enough to read, not enough to flood the chat. */
export const TOOL_OUTPUT_LIMIT = 4000;

const CALLS = "gemini.calls";

/** Parses one line; unknown or malformed events produce nothing. */
export function parseGeminiLine(line: string, state: CliParseState): ProviderEvent[] {
  let event: unknown;
  try {
    event = JSON.parse(line);
  } catch {
    return [];
  }
  const calls =
    (state.values.get(CALLS) as Map<string, ToolCallRecord> | undefined) ??
    new Map<string, ToolCallRecord>();
  state.values.set(CALLS, calls);
  switch (stringField(event, "type")) {
    case "init": {
      const sessionId = stringField(event, "session_id");
      return sessionId ? [{ type: "session", providerSessionId: sessionId, resumable: true }] : [];
    }
    case "message": {
      const text = stringField(event, "content");
      return stringField(event, "role") === "assistant" && text
        ? [{ type: "text_delta", text }]
        : [];
    }
    case "tool_use": {
      const id = stringField(event, "tool_id");
      const name = stringField(event, "tool_name");
      if (!id || !name) {
        return [];
      }
      const parameters = field(event, "parameters");
      const summary = stringField(parameters, "command") ?? stringField(parameters, "description");
      const record: ToolCallRecord = {
        id,
        name,
        ...(summary ? { summary } : {}),
        input: parameters,
        state: "running",
      };
      calls.set(id, record);
      return [{ type: "tool_call", toolCall: record }];
    }
    case "tool_result": {
      const id = stringField(event, "tool_id");
      const record = id ? calls.get(id) : undefined;
      if (!record) {
        return [];
      }
      const output =
        stringField(event, "output") ?? stringField(event, "error", "message") ?? undefined;
      return [
        {
          type: "tool_result",
          toolCall: {
            ...record,
            ...(output === undefined ? {} : { output: output.slice(0, TOOL_OUTPUT_LIMIT) }),
            state: stringField(event, "status") === "success" ? "completed" : "failed",
          },
        },
      ];
    }
    case "result": {
      const stats = field(event, "stats");
      const input = numberField(stats, "input_tokens");
      const output = numberField(stats, "output_tokens");
      const cached = numberField(stats, "cached");
      const duration = numberField(stats, "duration_ms");
      const events: ProviderEvent[] = [];
      if (input !== undefined || output !== undefined) {
        events.push({
          type: "usage",
          usage: {
            limits: [],
            // `input` is what was not served from the cache; older releases
            // may only have the total.
            ...(input === undefined
              ? {}
              : { inputTokens: numberField(stats, "input") ?? Math.max(0, input - (cached ?? 0)) }),
            ...(output === undefined ? {} : { outputTokens: output }),
            ...(cached === undefined ? {} : { cacheReadTokens: cached }),
            ...(duration === undefined ? {} : { durationMs: duration }),
          },
        });
      }
      if (stringField(event, "status") === "error") {
        events.push({
          type: "error",
          error: {
            kind: "provider",
            message: stringField(event, "error", "message") ?? "Gemini CLI reported an error",
            retryable: false,
          },
        });
      }
      return events;
    }
    case "error": {
      const message =
        stringField(event, "message") ??
        stringField(event, "error", "message") ??
        "Gemini CLI reported an error";
      return [{ type: "error", error: { kind: "provider", message, retryable: false } }];
    }
    default:
      return [];
  }
}
