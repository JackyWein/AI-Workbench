import type { CliProviderProfileInput } from "@ai-workbench/provider-cli";

/**
 * Anthropic's Claude Code CLI as profile data (spec §16, §21).
 *
 * Every flag here was checked against `claude --help` of Claude Code 2.1.274.
 * What cannot be expressed as data — asking the tool for its models, limits
 * and sign-in, and reading tool calls out of its event stream — lives in the
 * extensions next to this file, so the generic adapter never names the tool.
 */
export const claudeCodeProfile: CliProviderProfileInput = {
  schemaVersion: 1,
  id: "claude-code",
  displayName: "Claude Code",
  description: "Anthropic's command line coding tool",
  website: "https://code.claude.com",
  icon: "claude",
  command: "claude",
  /*
   * Where the installers put the tool when it is not on PATH. The native
   * installer uses ~/.local/bin on every platform (claude.exe on Windows),
   * older "local" installs used ~/.claude/local, npm puts a shim in
   * %APPDATA%\npm on Windows, and Homebrew or a global npm links into
   * /opt/homebrew/bin or /usr/local/bin. Locations whose variables are missing
   * on the current platform are skipped.
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
    // A data-only fallback; the extension's probe also asks the tool whether
    // the stored sign-in is still usable, which this pattern cannot see.
    probeArgs: ["auth", "status", "--json"],
    authenticatedPattern: '"loggedIn"\\s*:\\s*true',
    unauthenticatedPattern: '"loggedIn"\\s*:\\s*false',
    loginHint: "Run `claude auth login` in a terminal to sign in.",
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
   * Only used when the tool cannot be asked (see `discoverModels`). These are
   * the aliases the tool resolves to its current models itself, so the list
   * cannot go stale the way concrete model names would.
   */
  models: [
    { id: "default", displayName: "Default", isDefault: true, source: "profile" },
    { id: "sonnet", displayName: "Sonnet (latest)", source: "profile" },
    { id: "opus", displayName: "Opus (latest)", source: "profile" },
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
  /*
   * Print mode has nobody to answer a permission prompt: whatever would ask is
   * denied and reported, and the permission mode decides everything else
   * (spec §54). So:
   * - default   the user's own Claude Code settings decide
   * - readOnly  plan mode: read and explore, no edits and no commands that
   *             change anything
   * - edit      file edits in the working directory are accepted; commands
   *             the settings do not already allow are denied
   * - full      every permission check is skipped. Only for trusted,
   *             isolated work; the tool itself refuses it when managed policy
   *             disables it.
   * The interactive interface takes the same flags and can ask the user.
   */
  permissionArgs: {
    readOnly: ["--permission-mode", "plan"],
    edit: ["--permission-mode", "acceptEdits"],
    full: ["--dangerously-skip-permissions"],
  },
  instructionArgs: ["--append-system-prompt", "{systemInstructions}"],
  /*
   * The session's servers are added to the user's own; --strict-mcp-config is
   * deliberately absent so those keep working. --mcp-config takes several
   * values, which is safe here because nothing positional follows it: the
   * prompt goes through stdin.
   */
  mcp: { via: "json-arg", args: ["--mcp-config", "{mcpConfig}"] },
  resumeArgs: ["--resume", "{providerSessionId}"],
  promptVia: "stdin",
  interactive: { args: [] },
  accounts: {
    homeVariable: "CLAUDE_CONFIG_DIR",
    defaultHome: "~/.claude",
    detect: ["~/.claude-*"],
    // .credentials.json holds a sign-in on Windows and Linux; on macOS the
    // sign-in lives in the keychain and .claude.json is what a used home has.
    markers: [".credentials.json", ".claude.json"],
    loginArgs: ["auth", "login"],
  },
  /*
   * The extension's `parseLine` decodes every event it knows; these rules are
   * the data-only fallback for anything it hands back, and for a copy of this
   * profile used without the extension.
   */
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
      },
    ],
  },
  errorPatterns: [
    { pattern: "usage limit|hit your limit|limit reached", kind: "rateLimit" },
    { pattern: "please run /login|oauth token|invalid api key", kind: "authentication" },
  ],
};
