import type { CliProviderProfileInput } from "./profile.js";

/**
 * Profiles for the CLIs this project targets first (spec §21).
 *
 * They are the adapter's provider-specific knowledge expressed as data.
 *
 * The Claude Code profile was checked against the real tool: its flags against
 * `claude --help`, and its event mapping against a recorded live stream that is
 * replayed in the test suite. The rest are marked `unverified` — their flags
 * and event shapes are a documented starting point, not a validated
 * integration, and the UI says so rather than implying more (spec §0).
 *
 * None of these tools has a command that lists the models an account may use,
 * so only Claude Code ships one. The others start empty and are filled in on
 * the Providers screen, which is also how a model reaches a provider the
 * profiles do not know about.
 */

/** Anthropic's Claude Code CLI, in non-interactive streaming JSON mode. */
export const claudeCodeProfile: CliProviderProfileInput = {
  schemaVersion: 1,
  id: "claude-code",
  displayName: "Claude Code",
  description: "Anthropic's command line coding tool, run non-interactively",
  website: "https://code.claude.com",
  command: "claude",
  icon: "claude-code",
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
  icon: "codex",
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
  // The tool has no command that lists its models, so none are assumed. Add
  // the ones your account can use under Providers.
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

/**
 * Google's Antigravity CLI (`agy`), in headless mode with plain text output.
 *
 * It replaced the Gemini CLI, which Google retired for individual users; the
 * separate `gemini` profile below stays for the paid plans that keep it.
 */
export const antigravityProfile: CliProviderProfileInput = {
  schemaVersion: 1,
  id: "antigravity",
  displayName: "Antigravity",
  description: "Google's terminal coding agent, run headlessly",
  website: "https://antigravity.google",
  command: "agy",
  icon: "antigravity",
  versionArgs: ["--version"],
  auth: {
    method: "cli",
    loginHint: "Run `agy` once and complete the sign-in.",
  },
  capabilities: ["chat", "streaming", "modelSelection", "cliAuthentication"],
  // The tool has no command that lists its models, so none are assumed. Add
  // the ones your account can use under Providers.
  models: [],
  args: [],
  modelArgs: ["--model", "{model}"],
  promptVia: "arg",
  promptArgs: ["--print", "{prompt}"],
  // Plain stdout is the answer; no event format is assumed.
  output: { format: "text" },
  unverified: true,
};

/**
 * Where Windows shims of package-manager CLIs usually live when the installer
 * did not put them on PATH: bun, npm-global and friends. `~`, `%VAR%` expand;
 * missing entries are skipped by discovery.
 */
const WINDOWS_SHIM_LOCATIONS: readonly string[] = [
  "%USERPROFILE%/.bun/bin",
  "%APPDATA%/npm",
  "~/.local/bin",
];

/** Google's Gemini CLI, still available on the paid plans that kept it. */
export const geminiProfile: CliProviderProfileInput = {
  schemaVersion: 1,
  id: "gemini",
  displayName: "Gemini CLI",
  description: "Google's previous command line tool, replaced by Antigravity",
  command: "gemini",
  icon: "gemini",
  knownLocations: [...WINDOWS_SHIM_LOCATIONS],
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
  output: { format: "text" },
  unverified: true,
};

/**
 * SST's OpenCode CLI (`opencode`), headless via `opencode run`.
 *
 * Unverified starting point like the other non-Claude profiles: flags from
 * `opencode --help` still need a run against the real tool, and the UI says
 * so. Plain stdout is the answer; no event format is assumed.
 */
export const opencodeProfile: CliProviderProfileInput = {
  schemaVersion: 1,
  id: "opencode",
  displayName: "OpenCode",
  description: "SST's command line coding tool, run headlessly",
  website: "https://opencode.ai",
  command: "opencode",
  icon: "opencode",
  knownLocations: [...WINDOWS_SHIM_LOCATIONS],
  versionArgs: ["--version"],
  auth: {
    method: "cli",
    probeArgs: ["auth", "list"],
    authenticatedPattern: "stored",
    loginHint: "Run `opencode auth login` once in a terminal.",
  },
  capabilities: ["chat", "streaming", "sessionResume", "modelSelection", "cliAuthentication"],
  // Asked from the tool itself via `opencode models`; nothing is assumed here.
  models: [],
  modelsArgs: ["models"],
  args: ["run"],
  modelArgs: ["--model", "{model}"],
  resumeArgs: ["--session", "{providerSessionId}"],
  promptVia: "arg",
  promptArgs: ["{prompt}"],
  output: { format: "text" },
  unverified: true,
};

export const builtInCliProfiles: CliProviderProfileInput[] = [
  claudeCodeProfile,
  codexProfile,
  antigravityProfile,
  geminiProfile,
  opencodeProfile,
];
