import { z } from "zod";
import type { ProviderErrorKind, ProviderEvent, ToolCallRecord } from "@ai-workbench/shared";
import type { CliParseState } from "@ai-workbench/provider-cli";

/**
 * Decodes `codex exec --json` output into normalized events (spec §13).
 *
 * The stream is a sequence of thread, turn and item events. An item is one
 * piece of the agent's work — a message, a shell command, a file edit, an MCP
 * call — and arrives as `item.started`, any number of `item.updated` and one
 * `item.completed`, which is what lets a tool call show as running and then
 * be replaced by its result (the session keeps one record per id).
 *
 * The event and item names were checked against the installed binary; a
 * failing turn was recorded from the real tool. A successful turn could not be
 * recorded (the account's limit was exhausted), so item fields follow Codex's
 * documented shapes and anything unexpected is skipped rather than guessed at.
 */

/** Tool output kept per call: enough to read, not enough to flood the chat. */
const TOOL_OUTPUT_LIMIT = 4000;
const SUMMARY_LIMIT = 200;

const threadStartedSchema = z.object({ thread_id: z.string().min(1) });
const turnCompletedSchema = z.object({
  usage: z
    .object({
      input_tokens: z.number().nonnegative().nullish(),
      cached_input_tokens: z.number().nonnegative().nullish(),
      output_tokens: z.number().nonnegative().nullish(),
    })
    .passthrough()
    .nullish(),
});
const errorMessageSchema = z.object({ message: z.string() });
const turnFailedSchema = z.object({ error: errorMessageSchema.nullish() });
const itemEnvelopeSchema = z.object({
  item: z.object({ id: z.string().min(1), type: z.string() }).passthrough(),
});

const agentMessageSchema = z.object({ text: z.string().nullish() });
const commandSchema = z.object({
  command: z.string().nullish(),
  aggregated_output: z.string().nullish(),
  exit_code: z.number().nullish(),
  status: z.string().nullish(),
});
const fileChangeSchema = z.object({
  changes: z
    .array(z.object({ path: z.string(), kind: z.string().nullish() }).passthrough())
    .nullish(),
  status: z.string().nullish(),
});
const mcpCallSchema = z.object({
  server: z.string().nullish(),
  tool: z.string().nullish(),
  arguments: z.unknown().optional(),
  result: z.unknown().optional(),
  error: z.object({ message: z.string().nullish() }).passthrough().nullish(),
  status: z.string().nullish(),
});
const webSearchSchema = z.object({ query: z.string().nullish() });
const collabCallSchema = z.object({ tool: z.string().nullish(), status: z.string().nullish() });
const todoListSchema = z.object({
  items: z.array(z.object({ completed: z.boolean().nullish() }).passthrough()).nullish(),
});

type Phase = "item.started" | "item.updated" | "item.completed";
type Item = z.infer<typeof itemEnvelopeSchema>["item"];

/** Parses one line; unknown or malformed events produce nothing. */
export function parseCodexLine(line: string, state: CliParseState): ProviderEvent[] {
  let decoded: unknown;
  try {
    decoded = JSON.parse(line);
  } catch {
    return [];
  }
  if (typeof decoded !== "object" || decoded === null || Array.isArray(decoded)) {
    return [];
  }
  const type = (decoded as { type?: unknown }).type;

  switch (type) {
    case "thread.started": {
      const parsed = threadStartedSchema.safeParse(decoded);
      return parsed.success
        ? [{ type: "session", providerSessionId: parsed.data.thread_id, resumable: true }]
        : [];
    }
    case "item.started":
    case "item.updated":
    case "item.completed": {
      const parsed = itemEnvelopeSchema.safeParse(decoded);
      return parsed.success ? itemEvents(type, parsed.data.item, state) : [];
    }
    case "turn.completed":
      return usageEvents(decoded);
    case "turn.failed": {
      const parsed = turnFailedSchema.safeParse(decoded);
      const message = parsed.success ? parsed.data.error?.message : undefined;
      return errorEvents(message || "The turn failed", state);
    }
    case "error": {
      const parsed = errorMessageSchema.safeParse(decoded);
      if (!parsed.success) {
        return [];
      }
      // Codex retries a dropped stream by itself and says so as an error
      // event; the turn goes on, so it is a state, not a failure.
      if (/^reconnecting\b/i.test(parsed.data.message.trim())) {
        return [{ type: "status", status: "reconnecting", detail: parsed.data.message }];
      }
      return errorEvents(parsed.data.message, state);
    }
    default:
      return [];
  }
}

/** Sorts a Codex error message into the normalized kinds (spec §13). */
function classifyCodexError(message: string): ProviderErrorKind {
  if (/usage limit|rate limit|too many requests|\b429\b|quota/i.test(message)) {
    return "rateLimit";
  }
  if (/not logged in|\b401\b|unauthori[sz]ed|(?:log|sign) ?in again|refresh token/i.test(message)) {
    return "authentication";
  }
  return "provider";
}

function itemEvents(phase: Phase, item: Item, state: CliParseState): ProviderEvent[] {
  switch (item.type) {
    case "agent_message":
      return phase === "item.completed" ? agentMessage(item, state) : [];
    case "reasoning":
      // The reasoning text stays with the tool; only the state is shown.
      return once(state, "thinking", item.id)
        ? [{ type: "status", status: "thinking" }]
        : [];
    case "command_execution":
      return toolEvents(phase, commandCall(item));
    case "file_change":
      return toolEvents(phase, fileChangeCall(item));
    case "mcp_tool_call":
      return toolEvents(phase, mcpCall(item));
    case "web_search":
      return toolEvents(phase, webSearchCall(item, phase));
    case "collab_tool_call":
      return toolEvents(phase, collabCall(item));
    case "todo_list":
      return phase === "item.completed" ? [] : planStatus(item);
    case "error": {
      // A non-fatal problem the tool reports as an item; the turn goes on.
      const parsed = errorMessageSchema.safeParse(item);
      return phase === "item.completed" && parsed.success
        ? [{ type: "warning", message: parsed.data.message }]
        : [];
    }
    default:
      return [];
  }
}

function agentMessage(item: Item, state: CliParseState): ProviderEvent[] {
  const parsed = agentMessageSchema.safeParse(item);
  const text = parsed.success ? (parsed.data.text ?? "") : "";
  if (!text) {
    return [];
  }
  // Several messages in one turn are one answer in the chat; a blank line
  // keeps them from running into each other.
  const separator = state.values.get("codex.textEmitted") === true ? "\n\n" : "";
  state.values.set("codex.textEmitted", true);
  return [{ type: "text_delta", text: `${separator}${text}` }];
}

/** A tool call as the chat shows it; `completed` decides the final state. */
interface ToolView {
  readonly id: string;
  readonly name: string;
  readonly summary?: string;
  readonly input?: unknown;
  readonly output?: unknown;
  readonly succeeded: boolean;
}

function toolEvents(phase: Phase, view: ToolView | null): ProviderEvent[] {
  if (!view) {
    return [];
  }
  const record: ToolCallRecord = {
    id: view.id,
    name: view.name,
    ...(view.summary ? { summary: view.summary } : {}),
    ...(view.input === undefined ? {} : { input: view.input }),
    state: "running",
  };
  switch (phase) {
    case "item.started":
      return [{ type: "tool_call", toolCall: record }];
    case "item.updated":
      // Progress is not shown piecemeal; the result replaces the call.
      return [];
    case "item.completed":
      return [
        {
          type: "tool_result",
          toolCall: {
            ...record,
            ...(view.output === undefined ? {} : { output: view.output }),
            state: view.succeeded ? "completed" : "failed",
          },
        },
      ];
  }
}

function commandCall(item: Item): ToolView | null {
  const parsed = commandSchema.safeParse(item);
  if (!parsed.success) {
    return null;
  }
  const { command, aggregated_output: output, exit_code: exitCode, status } = parsed.data;
  return {
    id: item.id,
    name: "Shell",
    ...(command ? { summary: truncate(command, SUMMARY_LIMIT), input: { command } } : {}),
    ...(output ? { output: truncate(output, TOOL_OUTPUT_LIMIT) } : {}),
    succeeded: succeeded(status) && (exitCode === null || exitCode === undefined || exitCode === 0),
  };
}

function fileChangeCall(item: Item): ToolView | null {
  const parsed = fileChangeSchema.safeParse(item);
  if (!parsed.success) {
    return null;
  }
  const changes = parsed.data.changes ?? [];
  const paths = changes.map((change) => change.path);
  return {
    id: item.id,
    name: "Edit files",
    ...(paths.length > 0 ? { summary: summarizePaths(paths) } : {}),
    ...(changes.length > 0
      ? { input: { changes: changes.map(({ path, kind }) => ({ path, kind: kind ?? null })) } }
      : {}),
    succeeded: succeeded(parsed.data.status),
  };
}

function mcpCall(item: Item): ToolView | null {
  const parsed = mcpCallSchema.safeParse(item);
  if (!parsed.success) {
    return null;
  }
  const { server, tool, arguments: args, result, error, status } = parsed.data;
  const name = [server, tool].filter(Boolean).join(".") || "MCP tool";
  const errorText = error?.message?.trim();
  const output = errorText ? errorText : mcpResultText(result);
  return {
    id: item.id,
    name,
    ...(args === undefined || args === null ? {} : { input: args }),
    ...(output === undefined ? {} : { output }),
    succeeded: succeeded(status) && !errorText,
  };
}

function webSearchCall(item: Item, phase: Phase): ToolView | null {
  const parsed = webSearchSchema.safeParse(item);
  const query = parsed.success ? parsed.data.query?.trim() : undefined;
  return {
    id: item.id,
    name: "Web search",
    ...(query ? { summary: truncate(query, SUMMARY_LIMIT), input: { query } } : {}),
    // A search item has no status; completing it is its success.
    succeeded: phase === "item.completed",
  };
}

function collabCall(item: Item): ToolView | null {
  const parsed = collabCallSchema.safeParse(item);
  if (!parsed.success) {
    return null;
  }
  const tool = parsed.data.tool?.replace(/_/g, " ").trim();
  return {
    id: item.id,
    name: "Agents",
    ...(tool ? { summary: tool } : {}),
    succeeded: succeeded(parsed.data.status),
  };
}

function planStatus(item: Item): ProviderEvent[] {
  const parsed = todoListSchema.safeParse(item);
  const items = parsed.success ? (parsed.data.items ?? []) : [];
  if (items.length === 0) {
    return [];
  }
  const done = items.filter((entry) => entry.completed === true).length;
  return [{ type: "status", status: "working", detail: `Plan: ${done} of ${items.length} done` }];
}

function usageEvents(decoded: unknown): ProviderEvent[] {
  const parsed = turnCompletedSchema.safeParse(decoded);
  const usage = parsed.success ? parsed.data.usage : undefined;
  if (!usage) {
    return [];
  }
  return [
    {
      type: "usage",
      usage: {
        limits: [],
        // Codex counts cached input inside input_tokens, as the API does.
        ...(typeof usage.input_tokens === "number" ? { inputTokens: usage.input_tokens } : {}),
        ...(typeof usage.output_tokens === "number" ? { outputTokens: usage.output_tokens } : {}),
      },
    },
  ];
}

/**
 * A fatal error arrives twice — as `error` and again inside `turn.failed` —
 * so the same message is reported once per turn.
 */
function errorEvents(message: string, state: CliParseState): ProviderEvent[] {
  if (!once(state, "error", message)) {
    return [];
  }
  return [
    {
      type: "error",
      error: { kind: classifyCodexError(message), message, retryable: false },
    },
  ];
}

/** True the first time a key is seen in this turn. */
function once(state: CliParseState, group: string, key: string): boolean {
  const name = `codex.seen.${group}`;
  const existing = state.values.get(name);
  const seen = existing instanceof Set ? (existing as Set<string>) : new Set<string>();
  if (seen.has(key)) {
    return false;
  }
  seen.add(key);
  state.values.set(name, seen);
  return true;
}

function succeeded(status: string | null | undefined): boolean {
  return status !== "failed" && status !== "declined";
}

/** The text an MCP result carries, or the result itself when it has none. */
function mcpResultText(result: unknown): string | undefined {
  if (result === undefined || result === null) {
    return undefined;
  }
  const content = (result as { content?: unknown }).content;
  if (Array.isArray(content)) {
    const texts = content
      .map((part) =>
        typeof part === "object" && part !== null && typeof (part as { text?: unknown }).text === "string"
          ? (part as { text: string }).text
          : null,
      )
      .filter((text): text is string => text !== null);
    if (texts.length > 0) {
      return truncate(texts.join("\n"), TOOL_OUTPUT_LIMIT);
    }
  }
  try {
    return truncate(JSON.stringify(result), TOOL_OUTPUT_LIMIT);
  } catch {
    return undefined;
  }
}

function summarizePaths(paths: readonly string[]): string {
  const shown = paths.slice(0, 3).join(", ");
  const rest = paths.length - 3;
  return truncate(rest > 0 ? `${shown} and ${rest} more` : shown, SUMMARY_LIMIT);
}

function truncate(text: string, limit: number): string {
  return text.length > limit
    ? `${text.slice(0, limit)}\n… ${text.length - limit} more characters`
    : text;
}
