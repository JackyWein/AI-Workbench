import type { CliProviderProfileInput } from "@ai-workbench/provider-cli";

/**
 * Anthropic's Claude Code CLI as profile data (spec §16, §21).
 *
 * Every flag here was checked against `claude --help` of Claude Code 2.1.280.
 * What cannot be expressed as data — following an interactive run through the
 * tool's status line hook — lives in the extensions next to this file, so the
 * generic adapter never names the tool.
 */
export const claudeCodeProfile: CliProviderProfileInput = {
  schemaVersion: 1,
  id: "claude-code",
  displayName: "Claude Code",
  description: "Anthropic's command line coding tool",
  website: "https://code.claude.com",
  icon: "claude-code",
  command: "claude",
  /*
   * Where the installers put the tool when it is not on PATH. The native
   * installer uses ~/.local/bin (claude.exe on Windows), older "local"
   * installs used ~/.claude/local, and npm puts a shim in %APPDATA%\npm.
   */
  knownLocations: [
    "~/.local/bin/claude.exe",
    "~/.local/bin/claude",
    "~/.claude/local/claude",
    "%APPDATA%/npm/claude.cmd",
    "/opt/homebrew/bin/claude",
    "/usr/local/bin/claude",
  ],
  versionArgs: ["--version"],
  auth: {
    method: "cli",
    // `claude auth status` prints JSON and spends no quota, so the sign-in
    // state is known before the first turn. Checked against the installed tool.
    probeArgs: ["auth", "status"],
    signedInPath: "loggedIn",
    accountPath: "authMethod",
    planPath: "subscriptionType",
    loginHint: "Run `claude auth login` once in a terminal.",
  },
  capabilities: [
    "chat",
    "streaming",
    "sessionResume",
    "modelSelection",
    "reasoningModes",
    "toolCalls",
    "nativeTools",
    "mcp",
    "terminal",
    "filesystem",
    "cliAuthentication",
    "usage",
    "contextInformation",
    "interactiveTerminal",
    "accounts",
  ],
  /*
   * Aliases the tool resolves to its current models itself, so the list
   * cannot go stale the way concrete model names would.
   */
  models: [
    { id: "default", displayName: "Default", isDefault: true, source: "profile" },
    { id: "opus", displayName: "Opus (latest)", source: "profile" },
    { id: "sonnet", displayName: "Sonnet (latest)", source: "profile" },
    { id: "haiku", displayName: "Haiku (latest)", source: "profile" },
  ],
  /*
   * --verbose is required for stream-json in print mode. Without
   * --include-partial-messages the tool only prints complete messages, so the
   * answer would arrive in one piece instead of streaming.
   */
  args: ["--print", "--output-format", "stream-json", "--verbose", "--include-partial-messages"],
  modelArgs: ["--model", "{model}"],
  effortArgs: ["--effort", "{effort}"],
  effortOptions: ["low", "medium", "high", "xhigh", "max"],
  /*
   * Print mode has nobody to answer a permission prompt: whatever would ask is
   * denied and reported, and the permission mode decides everything else
   * (spec §54). "default" leaves the user's own Claude Code settings in charge.
   */
  permissionArgs: {
    readOnly: ["--permission-mode", "plan"],
    edit: ["--permission-mode", "acceptEdits"],
    full: ["--dangerously-skip-permissions"],
  },
  instructionArgs: ["--append-system-prompt", "{systemInstructions}"],
  /*
   * The session's servers are added to the user's own; --strict-mcp-config is
   * deliberately absent so those keep working.
   */
  mcp: {
    via: "json-arg",
    args: ["--mcp-config", "{mcpConfig}"],
    // A server-wide permission rule approves every tool of the application's
    // own read-only servers (memory, skills); nothing else is pre-approved.
    trust: { args: ["--allowedTools", "{trusted}"], item: "mcp__{server}" },
  },
  resumeArgs: ["--resume", "{providerSessionId}"],
  promptVia: "stdin",
  // Files are listed in the prompt and read with Claude Code's own Read tool,
  // pictures included. It asks before reading outside its folders, which a
  // headless turn cannot answer, so the files' folder is added (checked with
  // Claude Code and a stand-in API: refused without it, read with it).
  attachments: { directoryArgs: ["--add-dir", "{directory}"] },
  interactive: { args: [] },
  // Set by Claude Code for everything it starts. Inherited, they would make
  // each run a child session that keeps no transcript of its own.
  hostEnvUnset: [
    "CLAUDECODE",
    "CLAUDE_CODE_CHILD_SESSION",
    "CLAUDE_CODE_SESSION_ID",
    "CLAUDE_CODE_SESSION_ATTENDED",
    "CLAUDE_CODE_ENTRYPOINT",
    "CLAUDE_CODE_EXECPATH",
    "CLAUDE_CODE_MESSAGING_SOCKET",
    "CLAUDE_CODE_MESSAGING_TOKEN",
    "CLAUDE_PID",
  ],
  accounts: {
    homeVariable: "CLAUDE_CONFIG_DIR",
    defaultHome: "~/.claude",
    detect: ["~/.claude-*"],
    // .credentials.json holds a sign-in on Windows; .claude.json is what any
    // used home has.
    markers: [".credentials.json", ".claude.json"],
    loginArgs: ["auth", "login"],
  },
  output: {
    format: "json-lines",
    rules: [
      { emit: "session", when: { type: "system", subtype: "init" }, valueKey: "session_id" },
      {
        emit: "text_delta",
        when: { type: "stream_event", "event.delta.type": "text_delta" },
        valueKey: "event.delta.text",
      },
      // Complete messages repeat the streamed text; ignoring them keeps the
      // answer from being written twice.
      { emit: "ignore", when: { type: "assistant" } },
      // Real account usage, reported by the tool during a turn (spec §55).
      // Checked against a live stream of Claude Code 2.1.280.
      {
        emit: "usage",
        when: { type: "rate_limit_event" },
        limits: [
          {
            id: "five_hour",
            label: "5-hour window",
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
        cacheReadTokensKey: "usage.cache_read_input_tokens",
        cacheWriteTokensKey: "usage.cache_creation_input_tokens",
        costKey: "total_cost_usd",
        durationKey: "duration_ms",
      },
    ],
  },
  errorPatterns: [
    { pattern: "usage limit|hit your limit|limit reached", kind: "rateLimit" },
    { pattern: "please run /login|oauth token|invalid api key", kind: "authentication" },
  ],
};
