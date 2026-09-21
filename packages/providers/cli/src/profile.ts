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

export const cliProviderProfileSchema = z.object({
  /** Bumped when the profile shape changes, so profiles can be migrated. */
  schemaVersion: z.literal(1),
  id: z.string().min(1),
  displayName: z.string().min(1),
  description: z.string().optional(),
  website: z.string().url().optional(),
  /** Executable looked up on PATH unless a path is configured. */
  command: z.string().min(1),
  versionArgs: z.array(z.string()).default(["--version"]),
  auth: cliAuthSchema.default({ method: "cli" }),
  capabilities: z.array(providerCapabilitySchema),
  models: z.array(modelInfoSchema).default([]),

  /** Always-present arguments. */
  args: z.array(z.string()).default([]),
  /** Added when a model is selected. Supports {model}. */
  modelArgs: z.array(z.string()).default([]),
  /** Added when continuing a provider session. Supports {providerSessionId}. */
  resumeArgs: z.array(z.string()).default([]),
  /**
   * "append" adds the resume arguments after the base ones; "replace" swaps the
   * base arguments out entirely, for CLIs where resuming is its own subcommand.
   */
  resumeMode: z.enum(["append", "replace"]).default("append"),
  /** How the prompt reaches the CLI. */
  promptVia: z.enum(["stdin", "arg"]).default("stdin"),
  /** Used when promptVia is "arg". Supports {prompt}. */
  promptArgs: z.array(z.string()).default(["{prompt}"]),

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

/** Replaces {placeholders}; returns null when any placeholder is unresolved. */
export function substitute(
  args: string[],
  values: Record<string, string | undefined>,
): string[] | null {
  const result: string[] = [];
  for (const arg of args) {
    let replaced = arg;
    let unresolved = false;
    replaced = replaced.replace(/\{(\w+)\}/g, (_match, key: string) => {
      const value = values[key];
      if (value === undefined || value === "") {
        unresolved = true;
        return "";
      }
      return value;
    });
    if (unresolved) {
      return null;
    }
    result.push(replaced);
  }
  return result;
}
