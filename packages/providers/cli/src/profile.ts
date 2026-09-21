import { z } from "zod";
import {
  authMethodSchema,
  modelInfoSchema,
  providerCapabilitySchema,
} from "@ai-workbench/shared";

/**
 * A CLI provider profile is the provider-specific knowledge — which executable,
 * which flags, which output shape — expressed as data instead of code.
 *
 * This keeps generic code free of provider names (spec §3) and means a user can
 * correct a changed flag or add an entirely new CLI provider without any code
 * change (spec §16).
 */

/** Matches a decoded JSON event by exact values at dot-paths. */
const whenSchema = z.record(z.string());

/** Derives one usage limit from provider fields (spec §55). */
export const usageLimitRuleSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  /** Fraction between 0 and 1 of the limit already consumed. */
  utilizationKey: z.string().optional(),
  usedKey: z.string().optional(),
  remainingKey: z.string().optional(),
  totalKey: z.string().optional(),
  resetsAtKey: z.string().optional(),
  resetsAtUnit: z.enum(["seconds", "milliseconds", "iso"]).default("seconds"),
});
export type UsageLimitRule = z.infer<typeof usageLimitRuleSchema>;

export const jsonRuleSchema = z.object({
  emit: z.enum([
    "text_delta",
    "message",
    "status",
    "session",
    "usage",
    "error",
    "ignore",
  ]),
  when: whenSchema.default({}),
  /** Dot-path to the payload: the text, status, session id or error message. */
  valueKey: z.string().optional(),
  inputTokensKey: z.string().optional(),
  outputTokensKey: z.string().optional(),
  limits: z.array(usageLimitRuleSchema).default([]),
});
export type JsonRule = z.infer<typeof jsonRuleSchema>;

export const cliOutputSchema = z.discriminatedUnion("format", [
  z.object({
    /** Every stdout line is answer text. Works with any CLI that just prints. */
    format: z.literal("text"),
  }),
  z.object({
    format: z.literal("json-lines"),
    /** First matching rule wins; unmatched events are ignored. */
    rules: z.array(jsonRuleSchema).min(1),
    /** Lines that are not valid JSON are dropped instead of failing the turn. */
    ignoreUnparsable: z.boolean().default(true),
  }),
]);
export type CliOutput = z.infer<typeof cliOutputSchema>;

export const cliAuthSchema = z.object({
  method: authMethodSchema.default("cli"),
  /** Arguments for a status probe, e.g. ["auth", "status"]. */
  probeArgs: z.array(z.string()).optional(),
  /** Regular expressions matched against the probe's combined output. */
  authenticatedPattern: z.string().optional(),
  unauthenticatedPattern: z.string().optional(),
  /** Shown to the user when authentication is missing. */
  loginHint: z.string().optional(),
});
export type CliAuth = z.infer<typeof cliAuthSchema>;

/** Arguments per permission mode (spec §54); a missing mode adds nothing. */
export const permissionArgsSchema = z
  .object({
    default: z.array(z.string()).optional(),
    readOnly: z.array(z.string()).optional(),
    edit: z.array(z.string()).optional(),
    full: z.array(z.string()).optional(),
  })
  .default({});
export type PermissionArgs = z.infer<typeof permissionArgsSchema>;

/**
 * How the MCP servers a session may use reach the tool (spec §36, §38).
 *
 * - json-arg          one argument holding `{"mcpServers": {...}}`, the format
 *                     most tools share; `{mcpConfig}` in `args` is replaced
 * - config-overrides  one `flag root.<id>.<key>=<value>` pair per setting,
 *                     values written as TOML
 * - env-json          a variable holding `{"<root>": {...}}` in the tool's own
 *                     configuration format
 */
export const cliMcpSchema = z
  .discriminatedUnion("via", [
    z.object({ via: z.literal("none") }),
    z.object({ via: z.literal("json-arg"), args: z.array(z.string()).min(1) }),
    z.object({
      via: z.literal("config-overrides"),
      flag: z.string().min(1),
      root: z.string().min(1),
    }),
    z.object({
      via: z.literal("env-json"),
      variable: z.string().min(1),
      root: z.string().min(1),
    }),
    /** The provider's extension formats the servers itself (`mcpLaunch`). */
    z.object({ via: z.literal("extension") }),
  ])
  .default({ via: "none" });
export type CliMcp = z.infer<typeof cliMcpSchema>;

/** The tool's own interactive interface, run in a terminal (spec §26). */
export const cliInteractiveSchema = z.object({
  /** Always-present arguments; model and effort arguments are shared. */
  args: z.array(z.string()).default([]),
  /** Overrides the headless permission arguments where they differ. */
  permissionArgs: permissionArgsSchema.optional(),
  /** Overrides the headless instruction arguments where they differ. */
  instructionArgs: z.array(z.string()).optional(),
});
export type CliInteractive = z.infer<typeof cliInteractiveSchema>;

/**
 * Separate accounts of one tool. Each account is a configuration home the tool
 * is pointed at with an environment variable, so signing in, settings and
 * history stay apart the way the tool itself keeps them apart.
 */
export const cliAccountsSchema = z.object({
  /** Environment variable that selects the configuration home. */
  homeVariable: z.string().min(1),
  /** The home the tool uses when the variable is unset. ~ expands. */
  defaultHome: z.string().min(1),
  /**
   * Patterns for further homes that already exist, e.g. "~/.tool-*". Only the
   * last path segment may contain a "*".
   */
  detect: z.array(z.string()).default([]),
  /** A home only counts as an account when one of these files exists in it. */
  markers: z.array(z.string()).default([]),
  /** Arguments that start the tool's own sign-in for the selected home. */
  loginArgs: z.array(z.string()).default([]),
});
export type CliAccounts = z.infer<typeof cliAccountsSchema>;

export const cliProviderProfileSchema = z.object({
  /** Bumped when the profile shape changes, so profiles can be migrated. */
  schemaVersion: z.literal(1),
  id: z.string().min(1),
  displayName: z.string().min(1),
  description: z.string().optional(),
  website: z.string().url().optional(),
  /** Executable looked up on PATH unless a path is configured. */
  command: z.string().min(1),
  /**
   * Where the tool is commonly installed when it is not on PATH, tried in
   * order. `~`, `%VAR%` and `$VAR` expand; missing variables skip the entry.
   */
  knownLocations: z.array(z.string()).default([]),
  /** A key the UI turns into the tool's logo; never a behaviour switch. */
  icon: z.string().optional(),
  versionArgs: z.array(z.string()).default(["--version"]),
  auth: cliAuthSchema.default({ method: "cli" }),
  capabilities: z.array(providerCapabilitySchema),
  models: z.array(modelInfoSchema).default([]),

  /** Always-present arguments. */
  args: z.array(z.string()).default([]),
  /** Added when a model is selected. Supports {model}. */
  modelArgs: z.array(z.string()).default([]),
  /** Added when a reasoning effort is selected. Supports {effort}. */
  effortArgs: z.array(z.string()).default([]),
  permissionArgs: permissionArgsSchema,
  /**
   * How the session's effective skill instructions reach the tool (spec §30).
   * Supports {systemInstructions}. Empty means the tool cannot take them.
   */
  instructionArgs: z.array(z.string()).default([]),
  mcp: cliMcpSchema,
  /** Added when continuing a provider session. Supports {providerSessionId}. */
  resumeArgs: z.array(z.string()).default([]),
  /**
   * Lists the models the account may use, one `provider/model` per stdout
   * line (like `opencode models`). Empty means the tool has no such command
   * and the list stays manual (spec §21: nothing is guessed on its behalf).
   */
  modelsArgs: z.array(z.string()).default([]),
  /**
   * Reads account usage without spending a turn (like `opencode stats
   * --json`). Empty means the tool has no such command and usage stays
   * "unavailable" until a turn reports numbers (spec §55, §56, §108).
   */
  usageArgs: z.array(z.string()).default([]),
  /**
   * How to read the usage command's stdout. Only formats implemented here
   * count; anything else keeps usage unavailable rather than guessed.
   */
  usageFormat: z.enum(["opencode-stats"]).optional(),
  /**
   * Reasoning effort levels the tool accepts for `--effort` (like Antigravity's
   * low|medium|high). Empty means the tool takes none and no picker appears.
   */
  effortOptions: z.array(z.string().min(1)).max(12).default([]),
  /**
   * "append" adds the resume arguments after the base ones; "replace" swaps the
   * base arguments out entirely, for CLIs where resuming is its own subcommand.
   */
  resumeMode: z.enum(["append", "replace"]).default("append"),
  /** How the prompt reaches the CLI. */
  promptVia: z.enum(["stdin", "arg"]).default("stdin"),
  /** Used when promptVia is "arg". Supports {prompt}. */
  promptArgs: z.array(z.string()).default(["{prompt}"]),
  /**
   * Appended after everything else, e.g. "-" for tools that read the prompt
   * from stdin only when told to.
   */
  trailingArgs: z.array(z.string()).default([]),

  output: cliOutputSchema,
  env: z.record(z.string()).default({}),
  timeoutMs: z.number().int().positive().default(600_000),
  /** Extra classification for exit failures: regex source -> error kind. */
  errorPatterns: z
    .array(
      z.object({
        pattern: z.string(),
        kind: z.enum([
          "authentication",
          "rateLimit",
          "notInstalled",
          "timeout",
          "transport",
          "protocol",
          "provider",
        ]),
      }),
    )
    .default([]),
  /**
   * Set when the profile's flags have not been verified against the real CLI,
   * so the UI can say so instead of implying more confidence than we have.
   */
  unverified: z.boolean().default(false),
  /** Present when the tool can run as a terminal agent. */
  interactive: cliInteractiveSchema.optional(),
  accounts: cliAccountsSchema.optional(),
});

export type CliProviderProfile = z.infer<typeof cliProviderProfileSchema>;
export type CliProviderProfileInput = z.input<typeof cliProviderProfileSchema>;

export function parseProfile(input: unknown): CliProviderProfile {
  return cliProviderProfileSchema.parse(input);
}

/**
 * Reads a value at a dot-path such as "message.content.0.text".
 *
 * A "*" segment scans an array and returns the first element for which the rest
 * of the path resolves. That matters because a provider may put a thinking
 * block before the text block in the same message, so a fixed index would
 * silently lose the answer.
 */
export function readPath(value: unknown, path: string): unknown {
  return readSegments(value, path.split("."));
}

function readSegments(value: unknown, segments: string[]): unknown {
  if (segments.length === 0) {
    return value;
  }
  if (value === null || value === undefined) {
    return undefined;
  }

  const [segment, ...rest] = segments as [string, ...string[]];

  if (Array.isArray(value)) {
    if (segment === "*") {
      for (const entry of value) {
        const found = readSegments(entry, rest);
        if (found !== undefined) {
          return found;
        }
      }
      return undefined;
    }
    const index = Number(segment);
    return Number.isInteger(index) ? readSegments(value[index], rest) : undefined;
  }

  if (typeof value !== "object") {
    return undefined;
  }
  return readSegments((value as Record<string, unknown>)[segment], rest);
}

/**
 * Replaces {placeholders}; returns null when any placeholder is unresolved.
 *
 * `{name:json}` writes the value as a JSON string literal, which is also a
 * valid TOML basic string — how a multi-line value is passed to a tool that
 * parses its option values.
 */
export function substitute(
  args: string[],
  values: Record<string, string | undefined>,
): string[] | null {
  const result: string[] = [];
  for (const arg of args) {
    let unresolved = false;
    const replaced = arg.replace(
      /\{(\w+)(?::(\w+))?\}/g,
      (_match, key: string, filter: string | undefined) => {
        const value = values[key];
        if (value === undefined || value === "") {
          unresolved = true;
          return "";
        }
        return filter === "json" ? JSON.stringify(value) : value;
      },
    );
    if (unresolved) {
      return null;
    }
    result.push(replaced);
  }
  return result;
}
