import type { CliProviderProfileInput } from "./profile.js";

/**
 * Profiles for the CLIs this project targets first (spec §21).
 *
 * They are the adapter's provider-specific knowledge expressed as data.
 *
 * The Claude Code profile was checked against the real tool: its flags against
 * `claude --help`, and its event mapping against a recorded live stream that is
 * replayed in the test suite. The other two are marked `unverified` — their
 * flags and event shapes are a documented starting point, not a validated
 * integration, and the UI says so rather than implying more (spec §0).
 */

/** Anthropic's Claude Code CLI, in non-interactive streaming JSON mode. */
export const claudeCodeProfile: CliProviderProfileInput = {
  schemaVersion: 1,
  id: "claude-code",
  displayName: "Claude Code",
  description: "Anthropic's command line coding tool, run non-interactively",
  website: "https://code.claude.com",
  command: "claude",
  versionArgs: ["--version"],
  auth: {
    method: "cli",
    loginHint: "Start `claude` once in a terminal and sign in.",
  },
  capabilities: [
    "chat",
    "streaming",
    "sessionResume",
    "modelSelection",
    "toolCalls",
    "nativeTools",
    "mcp",
    "terminal",
    "filesystem",
    "cliAuthentication",
    "usage",
  ],
  models: [
    { id: "claude-opus-5", displayName: "Claude Opus 5", isDefault: true },
    { id: "claude-sonnet-5", displayName: "Claude Sonnet 5" },
    { id: "claude-haiku-4-5", displayName: "Claude Haiku 4.5" },
  ],
  args: ["--print", "--output-format", "stream-json", "--verbose"],
  modelArgs: ["--model", "{model}"],
  resumeArgs: ["--resume", "{providerSessionId}"],
  promptVia: "stdin",
  output: {
    format: "json-lines",
    rules: [
      { emit: "session", when: { type: "system", subtype: "init" }, valueKey: "session_id" },
      // Token-level deltas, so the answer streams as it is produced.
      {
        emit: "text_delta",
        when: { type: "stream_event", "event.delta.type": "text_delta" },
        valueKey: "event.delta.text",
      },
      // The same text also arrives as complete assistant messages; ignoring
      // them explicitly keeps the answer from being written twice.
      { emit: "ignore", when: { type: "assistant" } },
      // Real account usage, reported by the tool during a turn (spec §55).
      {
        emit: "usage",
        when: { type: "rate_limit_event" },
        limits: [
          {
            id: "five_hour",
            label: "5 hour window",
            utilizationKey: "rate_limit_info.unifiedWindows.five_hour.utilization",
            resetsAtKey: "rate_limit_info.unifiedWindows.five_hour.resetsAt",
          },
          {
            id: "seven_day",
            label: "Weekly",
            utilizationKey: "rate_limit_info.unifiedWindows.seven_day.utilization",
            resetsAtKey: "rate_limit_info.unifiedWindows.seven_day.resetsAt",
          },
        ],
      },
      { emit: "error", when: { type: "result", is_error: "true" }, valueKey: "result" },
      {
        emit: "usage",
        when: { type: "result" },
        inputTokensKey: "usage.input_tokens",
        outputTokensKey: "usage.output_tokens",
      },
    ],
  },
};

/** OpenAI's Codex CLI, in non-interactive JSON mode. */
export const codexProfile: CliProviderProfileInput = {
  schemaVersion: 1,
  id: "codex",
  displayName: "Codex",
  description: "OpenAI's command line coding tool, run non-interactively",
  command: "codex",
  versionArgs: ["--version"],
  auth: {
    method: "cli",
    loginHint: "Run `codex login` once in a terminal.",
  },
  capabilities: [
    "chat",
    "streaming",
    "sessionResume",
    "modelSelection",
    "toolCalls",
    "filesystem",
    "cliAuthentication",
  ],
  // Left empty on purpose: add the models you actually use in provider
  // settings rather than shipping a list that silently goes stale.
  models: [],
  args: ["exec", "--json"],
  modelArgs: ["--model", "{model}"],
  resumeArgs: ["exec", "resume", "{providerSessionId}", "--json"],
  resumeMode: "replace",
  promptVia: "arg",
  promptArgs: ["{prompt}"],
  output: {
    format: "json-lines",
    rules: [
      { emit: "session", when: { type: "thread.started" }, valueKey: "thread_id" },
      {
        emit: "text_delta",
        when: { type: "item.completed", "item.type": "agent_message" },
        valueKey: "item.text",
      },
      { emit: "error", when: { type: "error" }, valueKey: "message" },
    ],
  },
  unverified: true,
};

/** Google's Gemini CLI, in non-interactive mode with plain text output. */
export const geminiProfile: CliProviderProfileInput = {
  schemaVersion: 1,
  id: "gemini",
  displayName: "Gemini",
  description: "Google's command line AI tool, run non-interactively",
  command: "gemini",
  versionArgs: ["--version"],
  auth: {
    method: "cli",
    loginHint: "Run `gemini` once and complete the sign-in.",
  },
  capabilities: ["chat", "streaming", "modelSelection", "cliAuthentication"],
  models: [],
  args: [],
  modelArgs: ["--model", "{model}"],
  promptVia: "arg",
  promptArgs: ["--prompt", "{prompt}"],
  // Plain stdout is the answer; no event format is assumed.
  output: { format: "text" },
  unverified: true,
};

export const builtInCliProfiles: CliProviderProfileInput[] = [
  claudeCodeProfile,
  codexProfile,
  geminiProfile,
];
