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
    // `claude auth status` prints JSON and spends no quota, so the sign-in
    // state is known before the first turn rather than after it. Checked
    // against the installed tool.
    probeArgs: ["auth", "status"],
    signedInPath: "loggedIn",
    accountPath: "authMethod",
    loginHint: "Run `claude auth login` once in a terminal.",
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
  knownLocations: ["%LOCALAPPDATA%/agy/bin"],
  versionArgs: ["--version"],
  auth: {
    method: "cli",
    loginHint: "Run `agy` once and complete the sign-in.",
  },
  capabilities: ["chat", "streaming", "modelSelection", "cliAuthentication"],
  // Asked from the tool itself via `agy models` (`id\tDisplay` per line);
  // nothing is assumed here.
  models: [],
  modelsArgs: ["models"],
  args: [],
  // The interactive interface is the bare command (verified against
  // `agy --help` on 2026-09-23, installed at %LOCALAPPDATA%/agy/bin/agy.exe).
  // --continue/--conversation exist, but the resume output format has not
  // been measured, so sessionResume stays off until it has.
  interactive: { args: [] },
  modelArgs: ["--model", "{model}"],
  // Reasoning effort the tool accepts itself (verified against `agy --help`).
  effortArgs: ["--effort", "{effort}"],
  effortOptions: ["low", "medium", "high"],
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
  capabilities: [
    "chat",
    "streaming",
    "sessionResume",
    "modelSelection",
    "toolCalls",
    "nativeTools",
    "cliAuthentication",
    "mcp",
  ],
  // Servers reach it through a settings layer of its own (Gemini package).
  mcp: { via: "extension" },
  // The tool has no command that lists models, but it names its own aliases
  // and resolves them to whatever models are current (GEMINI_MODEL_ALIAS_* in
  // Gemini CLI 0.60, and its `/model` dialog). Offering those names guesses
  // nothing, and they stay right when Google moves to newer models: run on
  // 2026-09-23, `pro` asked the API for gemini-3.1-pro-preview and `flash`
  // for gemini-3.5-flash, not the names its own source constants still carry.
  models: [
    { id: "auto", displayName: "Auto", isDefault: true },
    { id: "pro", displayName: "Pro" },
    { id: "flash", displayName: "Flash" },
    { id: "flash-lite", displayName: "Flash Lite" },
  ],
  // Checked against Gemini CLI 0.60 with a stand-in for the Gemini API: the
  // event stream (read by the Gemini package; the rules below are the
  // fallback), `--resume` with the session id it reported, and a tool call.
  // A folder Gemini CLI does not trust yet is refused in headless mode; that
  // is the tool's own safety check, so it is reported, not skipped.
  args: ["--output-format", "stream-json"],
  resumeArgs: ["--resume", "{providerSessionId}"],
  modelArgs: ["--model", "{model}"],
  // Gemini CLI's own approval modes: plan is its read-only mode.
  permissionArgs: {
    readOnly: ["--approval-mode", "plan"],
    edit: ["--approval-mode", "auto_edit"],
    full: ["--approval-mode", "yolo"],
  },
  promptVia: "arg",
  promptArgs: ["--prompt", "{prompt}"],
  // Checked against Gemini CLI 0.60 with a stand-in API: an "@path" in a
  // headless prompt is read and sent, pictures inline. It reads only inside
  // its workspace, so the folder the files were copied to is added.
  attachments: {
    mentionPrefix: "@",
    directoryArgs: ["--include-directories", "{directory}"],
  },
  output: {
    format: "json-lines",
    rules: [
      { emit: "session", when: { type: "init" }, valueKey: "session_id" },
      { emit: "text_delta", when: { type: "message", role: "assistant" }, valueKey: "content" },
      {
        emit: "usage",
        when: { type: "result" },
        inputTokensKey: "stats.input_tokens",
        outputTokensKey: "stats.output_tokens",
        durationKey: "stats.duration_ms",
      },
      { emit: "error", when: { type: "error" }, valueKey: "message" },
    ],
  },
  interactive: { args: [] },
};

/**
 * SST's OpenCode CLI (`opencode`), headless via `opencode run`.
 *
 * Checked against OpenCode 1.18.32 with a local stand-in for the model:
 * `run --format json` prints one JSON event per line (read by the OpenCode
 * package; the rules below are the fallback without it), `--model` takes
 * `provider/model`, `--variant` a model's reasoning effort, and `--session`
 * continues a session. `run` also reads stdin while it is open, which the
 * transport closes at once.
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
  capabilities: [
    "chat",
    "streaming",
    "sessionResume",
    "modelSelection",
    "reasoningModes",
    "toolCalls",
    "nativeTools",
    "cliAuthentication",
    "usage",
    "mcp",
  ],
  // Servers reach it through OPENCODE_CONFIG_CONTENT (OpenCode package).
  mcp: { via: "extension" },
  // Asked from the tool itself via `opencode models`; nothing is assumed here.
  models: [],
  modelsArgs: ["models"],
  // Today's and this week's tokens and cost via `opencode stats`; no quota
  // exists to deplete, so these render as consumed amounts (spec §55, §56).
  usageArgs: ["stats", "--json"],
  usageFormat: "opencode-stats",
  args: ["run", "--format", "json"],
  // The terminal interface starts in the working directory it is given.
  interactive: { args: [] },
  modelArgs: ["--model", "{model}"],
  effortArgs: ["--variant", "{effort}"],
  resumeArgs: ["--session", "{providerSessionId}"],
  // OpenCode's own permission configuration decides, except for "full":
  // `--auto` approves whatever it does not explicitly deny. Its read-only
  // "plan" agent still allows shell commands, so it is no "read only". A
  // headless run turns every "ask" into a refusal, which shows as a failed
  // tool call with OpenCode's own message.
  permissionArgs: { full: ["--auto"] },
  promptVia: "arg",
  // "--" ends the options: `--file` takes any number of values and would
  // otherwise swallow the prompt, and a prompt starting with "-" stays words.
  promptArgs: ["--", "{prompt}"],
  // Checked against OpenCode 1.18 with a stand-in model: each file is read
  // and sent, pictures as images.
  attachments: { fileArgs: ["--file", "{path}"] },
  output: {
    format: "json-lines",
    rules: [
      { emit: "session", when: { type: "step_start" }, valueKey: "sessionID" },
      { emit: "text_delta", when: { type: "text" }, valueKey: "part.text" },
      {
        emit: "usage",
        when: { type: "step_finish" },
        inputTokensKey: "part.tokens.input",
        outputTokensKey: "part.tokens.output",
        costKey: "part.cost",
      },
      { emit: "error", when: { type: "error" }, valueKey: "error.data.message" },
    ],
  },
};

export const builtInCliProfiles: CliProviderProfileInput[] = [
  claudeCodeProfile,
  codexProfile,
  antigravityProfile,
  geminiProfile,
  opencodeProfile,
];
