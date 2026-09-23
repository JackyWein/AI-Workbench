import type { CliProviderProfileInput } from "@ai-workbench/provider-cli";

/**
 * OpenAI's Codex CLI as profile data (spec §16, §21).
 *
 * What was checked against the installed tool (codex-cli 0.155.1):
 *
 * - every flag below against `codex --help`, `codex exec --help` and
 *   `codex exec resume --help`. `exec resume` has no `-s`, so the sandbox is
 *   chosen with `-c sandbox_mode=...`, which both subcommands accept;
 * - the `-c` keys against the tool's generated protocol types (`Config`) and,
 *   with an empty configuration home, against `codex debug prompt-input`
 *   (`developer_instructions` becomes the first developer message, quotes and
 *   line breaks intact; `sandbox_mode` reaches the permission instructions)
 *   and `codex mcp list --json` (MCP overrides parse as written);
 * - models, sign-in and limits through the tool's own app server, which the
 *   extensions in this package read without spending a turn.
 *
 * What was not: a successful turn. The account used for verification had
 * exhausted its weekly limit, so only a failing turn stream was recorded. The
 * event mapping for a working turn follows the documented shapes, which is why
 * the profile stays marked `unverified` (see {@link codexNotice}).
 */
export const codexProfile: CliProviderProfileInput = {
  schemaVersion: 1,
  id: "codex",
  displayName: "Codex",
  description: "OpenAI's command line coding agent, run non-interactively",
  website: "https://developers.openai.com/codex",
  icon: "codex",
  command: "codex",
  // The standalone installer puts the tool under its own home and does not
  // touch PATH; npm, Homebrew and bun installs usually are on PATH already and
  // are listed for the environments where they are not. Windows entries come
  // first because a file without an extension cannot be started there.
  knownLocations: [
    "~/.codex/packages/standalone/current/bin/codex.exe",
    "~/.codex/packages/standalone/current/bin/codex",
    "%APPDATA%/npm/codex.cmd",
    "%LOCALAPPDATA%/pnpm/codex.cmd",
    "~/.bun/bin/codex.exe",
    "~/.bun/bin/codex",
    "~/.volta/bin/codex",
    "~/.npm-global/bin/codex",
    "~/.local/bin/codex",
    "/opt/homebrew/bin/codex",
    "/usr/local/bin/codex",
    "/home/linuxbrew/.linuxbrew/bin/codex",
  ],
  versionArgs: ["--version"],
  auth: {
    method: "cli",
    // Only a fallback: the extensions ask the app server, which also knows the
    // account and plan. Output checked for both states with the real tool.
    probeArgs: ["login", "status"],
    authenticatedPattern: "Logged in using",
    unauthenticatedPattern: "Not logged in",
    loginHint: "Run `codex login` once in a terminal.",
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
    "interactiveTerminal",
    "accounts",
  ],
  // The tool reports its models itself (`model/list`), so none are assumed.
  models: [],

  // `exec` waits for stdin to close even when given a prompt argument, so the
  // prompt always goes through stdin and "-" says so explicitly.
  args: ["exec", "--json", "--skip-git-repo-check"],
  resumeArgs: ["exec", "resume", "{providerSessionId}", "--json", "--skip-git-repo-check"],
  resumeMode: "replace",
  promptVia: "stdin",
  trailingArgs: ["-"],
  modelArgs: ["-m", "{model}"],
  // `-c` values are TOML; a JSON string literal is a valid TOML string.
  effortArgs: ["-c", "model_reasoning_effort={effort:json}"],
  permissionArgs: {
    readOnly: ["-c", 'sandbox_mode="read-only"'],
    edit: ["-c", 'sandbox_mode="workspace-write"'],
    full: ["--dangerously-bypass-approvals-and-sandbox"],
  },
  // Added as a developer message next to the tool's own instructions, which
  // `instructions` would replace.
  instructionArgs: ["-c", "developer_instructions={systemInstructions:json}"],
  mcp: { via: "config-overrides", flag: "-c", root: "mcp_servers" },

  // Only used when the extensions are absent; `parseCodexLine` covers more.
  output: {
    format: "json-lines",
    rules: [
      { emit: "session", when: { type: "thread.started" }, valueKey: "thread_id" },
      {
        emit: "text_delta",
        when: { type: "item.completed", "item.type": "agent_message" },
        valueKey: "item.text",
      },
      {
        emit: "usage",
        when: { type: "turn.completed" },
        inputTokensKey: "usage.input_tokens",
        outputTokensKey: "usage.output_tokens",
      },
      { emit: "error", when: { type: "turn.failed" }, valueKey: "error.message" },
      { emit: "error", when: { type: "error" }, valueKey: "message" },
    ],
  },
  errorPatterns: [{ pattern: "usage limit|rate limit", kind: "rateLimit" }],

  interactive: {
    args: [],
    // The interactive interface asks before leaving the sandbox; a headless
    // turn cannot answer, which is why only the terminal gets "on-request".
    permissionArgs: {
      readOnly: ["-s", "read-only", "-a", "on-request"],
      edit: ["-s", "workspace-write", "-a", "on-request"],
      full: ["--dangerously-bypass-approvals-and-sandbox"],
    },
  },
  accounts: {
    homeVariable: "CODEX_HOME",
    defaultHome: "~/.codex",
    detect: ["~/.codex-*"],
    markers: ["auth.json"],
    loginArgs: ["login"],
  },
  unverified: true,
};

/**
 * What is and is not verified about this provider, for the provider screen.
 *
 * The profile schema has no field for a provider-specific notice yet, so the
 * adapter shows its generic "unverified" text; this is the precise statement
 * to show instead once it can.
 */
export const codexNotice =
  "Models, sign-in, usage limits and every command line flag were checked " +
  "against the installed Codex CLI. A complete turn has not been observed yet, " +
  "so how its answer and tool calls are shown follows Codex's documented event " +
  "format.";
