import { describe, expect, it } from "vitest";
import { scanDiff, scanText } from "../secret-scan.js";

// Made-up values in the shapes the issuers document; none of them is real.
const GITHUB = `ghp_${"a1B2c3D4e5".repeat(4)}`;
const AWS = "AKIAIOSFODNN7EXAMPLE";

describe("finding likely secrets", () => {
  it("finds a token added in a diff, with its file and line, and shows only its start", () => {
    const diff = [
      "diff --git a/config.ts b/config.ts",
      "index 1111111..2222222 100644",
      "--- a/config.ts",
      "+++ b/config.ts",
      "@@ -10,2 +10,3 @@ export const config = {",
      "   name: \"app\",",
      `+  token: "${GITHUB}",`,
      "   debug: false,",
    ].join("\n");
    const findings = scanDiff(diff);
    expect(findings).toEqual([{ kind: "GitHub token", file: "config.ts", line: 11, preview: "ghp_a1…" }]);
    expect(JSON.stringify(findings)).not.toContain(GITHUB);
  });

  it("lets a removed secret go, and a new file's lines count from one", () => {
    const diff = [
      "--- a/old.env",
      "+++ /dev/null",
      "@@ -1 +0,0 @@",
      `-AWS_KEY=${AWS}`,
      "--- /dev/null",
      "+++ b/id_rsa",
      "@@ -0,0 +1,2 @@",
      "+-----BEGIN OPENSSH PRIVATE KEY-----",
      "+b3BlbnNzaC1rZXktdjEAAAAA",
    ].join("\n");
    expect(scanDiff(diff)).toEqual([{ kind: "Private key", file: "id_rsa", line: 1, preview: "-----B…" }]);
  });

  it("recognises the common key formats", () => {
    const kinds = scanText(
      [
        `aws = ${AWS}`,
        `sk-ant-api03-${"x1Y2z3".repeat(5)}`,
        `OPENAI=sk-proj-${"Ab12Cd34".repeat(5)}`,
        `AIza${"Sy0123456789abcdefghijABCDEFGHIJKLM"}`,
        `xoxb-${"1234567890"}-abcdefghij`,
        `password: "Tr0ub4dor&3xK9q2mZ"`,
      ].join("\n"),
    ).map((finding) => finding.kind);
    expect(kinds).toEqual([
      "AWS access key",
      "Anthropic API key",
      "OpenAI API key",
      "Google API key",
      "Slack token",
      "Password or key in code",
    ]);
  });

  it("leaves ordinary code and placeholders alone", () => {
    const text = [
      'const password = process.env.DB_PASSWORD;',
      'apiKey: "${API_KEY}"',
      'token: "your-token-goes-here"',
      'secret = "xxxxxxxxxxxxxxxxxxxx"',
      'const passwordField = "password-input-label";',
      "import { sk } from './keys';",
    ].join("\n");
    expect(scanText(text)).toEqual([]);
  });
});
