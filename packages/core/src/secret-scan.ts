import type { SecretFinding } from "@ai-workbench/shared";

interface Pattern {
  readonly kind: string;
  readonly pattern: RegExp;
  /** The group holding the secret itself, when the pattern has context around it. */
  readonly group?: number;
}

/**
 * Shapes of credentials that are unmistakable: a match is almost never
 * anything else. Kept to formats the issuers document, so the check stops
 * real leaks without nagging about ordinary code.
 */
const PATTERNS: readonly Pattern[] = [
  { kind: "Private key", pattern: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY-----/ },
  { kind: "GitHub token", pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{50,})\b/ },
  { kind: "Anthropic API key", pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}/ },
  { kind: "OpenAI API key", pattern: /\bsk-(?!ant-)(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{32,}/ },
  { kind: "AWS access key", pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { kind: "Google API key", pattern: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { kind: "Slack token", pattern: /\bxox[abposr]-[A-Za-z0-9-]{10,}/ },
  { kind: "Stripe secret key", pattern: /\b[rs]k_live_[0-9A-Za-z]{20,}/ },
  { kind: "npm token", pattern: /\bnpm_[A-Za-z0-9]{36}\b/ },
  {
    // A password or key written into code: a quoted value that looks random.
    kind: "Password or key in code",
    pattern:
      /\b(?:password|passwd|secret|api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret)\b["']?\s*[:=]\s*["']([^"'\s]{16,})["']/i,
    group: 1,
  },
];

/** Values that only look like a secret: placeholders, variables, examples. */
function isPlaceholder(value: string): boolean {
  return (
    /^[x*._-]+$/i.test(value) ||
    /[<>{}$]|\$\{|process\.env|example|placeholder|changeme|your[_-]/i.test(value) ||
    // Real keys mix letters and digits; a word or a path is not one.
    !/[0-9]/.test(value) ||
    !/[A-Za-z]/.test(value)
  );
}

function scanLine(text: string): Array<{ kind: string; value: string }> {
  const found: Array<{ kind: string; value: string }> = [];
  for (const entry of PATTERNS) {
    const match = entry.pattern.exec(text);
    if (!match) {
      continue;
    }
    const value = entry.group === undefined ? match[0] : (match[entry.group] ?? "");
    if (entry.group !== undefined && isPlaceholder(value)) {
      continue;
    }
    found.push({ kind: entry.kind, value });
  }
  return found;
}

function preview(value: string): string {
  return value.length <= 8 ? "…" : `${value.slice(0, 6)}…`;
}

/** Likely secrets in plain text, like a note about to be shared. */
export function scanText(text: string): SecretFinding[] {
  const findings: SecretFinding[] = [];
  text.split(/\r?\n/).forEach((line, index) => {
    for (const hit of scanLine(line)) {
      findings.push({ kind: hit.kind, file: null, line: index + 1, preview: preview(hit.value) });
    }
  });
  return findings;
}

/**
 * Likely secrets in what a unified diff adds — only the added lines, since
 * removing a leaked key is exactly what should be allowed to go through.
 */
export function scanDiff(diff: string): SecretFinding[] {
  const findings: SecretFinding[] = [];
  let file: string | null = null;
  let line = 0;
  for (const raw of diff.split(/\r?\n/)) {
    if (raw.startsWith("+++ ")) {
      const target = raw.slice(4).trim();
      file = target === "/dev/null" ? null : target.replace(/^b\//, "");
      continue;
    }
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
    if (hunk) {
      line = Number(hunk[1]);
      continue;
    }
    if (raw.startsWith("+")) {
      for (const hit of scanLine(raw.slice(1))) {
        findings.push({ kind: hit.kind, file, line, preview: preview(hit.value) });
      }
      line += 1;
    } else if (raw.startsWith(" ")) {
      line += 1;
    }
  }
  return findings;
}
