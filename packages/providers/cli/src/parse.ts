import type { ProviderErrorKind, ProviderEvent, UsageLimit } from "@ai-workbench/shared";
import {
  readPath,
  type CliProviderProfile,
  type JsonRule,
  type UsageLimitRule,
} from "./profile.js";

/**
 * Decodes one line of turn output with the profile's rules (spec §13, §16).
 * Only the profile's data decides what a line means; nothing here knows which
 * tool printed it.
 */
export function parseWithRules(profile: CliProviderProfile, line: string): ProviderEvent[] {
  const output = profile.output;

  if (output.format === "text") {
    return [{ type: "text_delta", text: `${line}\n` }];
  }

  let decoded: unknown;
  try {
    decoded = JSON.parse(line);
  } catch {
    return output.ignoreUnparsable
      ? []
      : [{ type: "warning", message: `Unexpected provider output: ${line.slice(0, 200)}` }];
  }

  const rule = output.rules.find((candidate) => matches(decoded, candidate));
  if (!rule || rule.emit === "ignore") {
    return [];
  }

  const value = rule.valueKey === undefined ? undefined : readPath(decoded, rule.valueKey);

  switch (rule.emit) {
    case "text_delta":
      return typeof value === "string" && value.length > 0
        ? [{ type: "text_delta", text: value }]
        : [];
    case "message":
      return typeof value === "string" ? [{ type: "message", text: value }] : [];
    case "status":
      return [{ type: "status", status: typeof value === "string" ? value : "working" }];
    case "session":
      return typeof value === "string" && value.length > 0
        ? [{ type: "session", providerSessionId: value, resumable: true }]
        : [];
    case "usage": {
      const inputTokens = numberAt(decoded, rule.inputTokensKey);
      const outputTokens = numberAt(decoded, rule.outputTokensKey);
      const optional = {
        cacheReadTokens: numberAt(decoded, rule.cacheReadTokensKey),
        cacheWriteTokens: numberAt(decoded, rule.cacheWriteTokensKey),
        costUsd: numberAt(decoded, rule.costKey),
        durationMs: numberAt(decoded, rule.durationKey),
      };
      const limits = rule.limits
        .map((limitRule) => buildLimit(decoded, limitRule))
        .filter((limit): limit is UsageLimit => limit !== null);
      return [
        {
          type: "usage",
          usage: {
            limits,
            ...(inputTokens === undefined ? {} : { inputTokens }),
            ...(outputTokens === undefined ? {} : { outputTokens }),
            ...Object.fromEntries(
              Object.entries(optional).filter(
                (entry): entry is [string, number] => entry[1] !== undefined && entry[1] >= 0,
              ),
            ),
          },
        },
      ];
    }
    case "error": {
      const text = typeof value === "string" ? value : "";
      return [
        {
          type: "error",
          error: {
            kind: classifyError(profile, text),
            message: text || "The provider reported an error",
            retryable: false,
          },
        },
      ];
    }
  }
}

/** Maps provider text onto a normalized error kind (spec §13). */
export function classifyError(profile: CliProviderProfile, text: string): ProviderErrorKind {
  for (const entry of profile.errorPatterns) {
    if (new RegExp(entry.pattern, "i").test(text)) {
      return entry.kind;
    }
  }
  if (/not logged in|unauthenticated|unauthorized|auth|login|credential/i.test(text)) {
    return "authentication";
  }
  if (/rate limit|usage limit|quota|too many requests|429/i.test(text)) {
    return "rateLimit";
  }
  if (/timed? out|timeout/i.test(text)) {
    return "timeout";
  }
  if (/not found|no such file|enoent/i.test(text)) {
    return "notInstalled";
  }
  return "provider";
}

function matches(decoded: unknown, rule: JsonRule): boolean {
  return Object.entries(rule.when).every(
    ([path, expected]) => String(readPath(decoded, path) ?? "") === expected,
  );
}

/** Turns provider fields into a usage limit, or null when nothing is known. */
function buildLimit(decoded: unknown, rule: UsageLimitRule): UsageLimit | null {
  const utilization = numberAt(decoded, rule.utilizationKey);
  const resetsAt = dateAt(decoded, rule.resetsAtKey, rule.resetsAtUnit);

  if (utilization !== undefined) {
    const used = Math.round(Math.max(0, Math.min(1, utilization)) * 100);
    return {
      id: rule.id,
      label: rule.label,
      used,
      remaining: 100 - used,
      total: 100,
      unit: "percent",
      ...(resetsAt === undefined ? {} : { resetsAt }),
    };
  }

  const used = numberAt(decoded, rule.usedKey);
  const remaining = numberAt(decoded, rule.remainingKey);
  const total = numberAt(decoded, rule.totalKey);
  if (used === undefined && remaining === undefined && total === undefined) {
    return null;
  }

  return {
    id: rule.id,
    label: rule.label,
    unit: "requests",
    ...(used === undefined ? {} : { used }),
    ...(remaining === undefined ? {} : { remaining }),
    ...(total === undefined ? {} : { total }),
    ...(resetsAt === undefined ? {} : { resetsAt }),
  };
}

function dateAt(
  decoded: unknown,
  path: string | undefined,
  unit: UsageLimitRule["resetsAtUnit"],
): Date | undefined {
  if (path === undefined) {
    return undefined;
  }
  const value = readPath(decoded, path);
  if (unit === "iso") {
    if (typeof value !== "string") {
      return undefined;
    }
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? undefined : parsed;
  }
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }
  return new Date(unit === "seconds" ? value * 1000 : value);
}

function numberAt(decoded: unknown, path: string | undefined): number | undefined {
  if (path === undefined) {
    return undefined;
  }
  const value = readPath(decoded, path);
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
