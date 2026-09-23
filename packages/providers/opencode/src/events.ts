import type { ProviderEvent, ToolCallRecord } from "@ai-workbench/shared";
import {
  field,
  numberField,
  stringField,
  type CliParseState,
} from "@ai-workbench/provider-cli";

/**
 * Decodes `opencode run --format json` into normalized events (spec §13).
 *
 * Recorded from OpenCode 1.18.32 against a local stand-in for the model: each
 * line is one event with a `type`, the run's `sessionID` and a `part`.
 *
 * - `step_start` opens a model step; its `sessionID` is the one `--session`
 *   resumes.
 * - `text` carries one finished text part.
 * - `tool_use` carries one finished tool call: `part.tool`, `part.callID` and
 *   `part.state` with `status`, `input`, `output` and a one-line `title`.
 * - `step_finish` closes a step with its own `tokens` and `cost`; a turn with
 *   a tool call has several steps, so the turn's totals are their sum.
 * - `error` carries `error.data.message`.
 */

/** Tool output kept per call: enough to read, not enough to flood the chat. */
export const TOOL_OUTPUT_LIMIT = 4000;

const TOTALS = "opencode.totals";

interface Totals {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
}

/** Parses one line; unknown or malformed events produce nothing. */
export function parseOpencodeLine(line: string, state: CliParseState): ProviderEvent[] {
  let event: unknown;
  try {
    event = JSON.parse(line);
  } catch {
    return [];
  }
  switch (stringField(event, "type")) {
    case "step_start": {
      const sessionId = stringField(event, "sessionID");
      if (!sessionId || state.values.get("opencode.session") === sessionId) {
        return [];
      }
      state.values.set("opencode.session", sessionId);
      return [{ type: "session", providerSessionId: sessionId, resumable: true }];
    }
    case "text": {
      const text = stringField(event, "part", "text");
      if (!text) {
        return [];
      }
      // Each part is a finished paragraph; parts of later steps (after a
      // tool call) must not run into the one before.
      const first = state.values.get("opencode.text") !== true;
      state.values.set("opencode.text", true);
      return [{ type: "text_delta", text: first ? text : `\n\n${text}` }];
    }
    case "tool_use":
      return toolEvents(field(event, "part"));
    case "step_finish":
      return usageOf(field(event, "part"), state);
    case "error": {
      const message =
        stringField(event, "error", "data", "message") ??
        stringField(event, "error", "name") ??
        "OpenCode reported an error";
      return [{ type: "error", error: { kind: "provider", message, retryable: false } }];
    }
    default:
      return [];
  }
}

function toolEvents(part: unknown): ProviderEvent[] {
  const name = stringField(part, "tool");
  const id = stringField(part, "callID") ?? stringField(part, "id");
  if (!name || !id) {
    return [];
  }
  const status = stringField(part, "state", "status");
  const title = stringField(part, "state", "title");
  const output = stringField(part, "state", "output") ?? stringField(part, "state", "error");
  const record: ToolCallRecord = {
    id,
    name,
    ...(title ? { summary: title } : {}),
    input: field(part, "state", "input"),
    state: "running",
  };
  // The JSON stream reports a call once it has finished, so the call and its
  // result arrive together.
  return [
    { type: "tool_call", toolCall: record },
    {
      type: "tool_result",
      toolCall: {
        ...record,
        ...(output === undefined ? {} : { output: output.slice(0, TOOL_OUTPUT_LIMIT) }),
        state: status === "error" ? "failed" : "completed",
      },
    },
  ];
}

function usageOf(part: unknown, state: CliParseState): ProviderEvent[] {
  const input = numberField(part, "tokens", "input");
  const output = numberField(part, "tokens", "output");
  if (input === undefined && output === undefined) {
    return [];
  }
  const previous = (state.values.get(TOTALS) as Totals | undefined) ?? {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cost: 0,
  };
  const totals: Totals = {
    input: previous.input + (input ?? 0),
    // Reasoning is output the model produced, and billed as such.
    output: previous.output + (output ?? 0) + (numberField(part, "tokens", "reasoning") ?? 0),
    cacheRead: previous.cacheRead + (numberField(part, "tokens", "cache", "read") ?? 0),
    cacheWrite: previous.cacheWrite + (numberField(part, "tokens", "cache", "write") ?? 0),
    cost: previous.cost + (numberField(part, "cost") ?? 0),
  };
  state.values.set(TOTALS, totals);
  return [
    {
      type: "usage",
      usage: {
        limits: [],
        inputTokens: totals.input,
        outputTokens: totals.output,
        cacheReadTokens: totals.cacheRead,
        cacheWriteTokens: totals.cacheWrite,
        // OpenCode prices the tokens itself from its model catalogue.
        costUsd: totals.cost,
      },
    },
  ];
}
