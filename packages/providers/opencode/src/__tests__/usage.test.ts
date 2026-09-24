import { describe, expect, it } from "vitest";
import type { CliExtensionContext } from "@ai-workbench/provider-cli";
import { readUsage } from "../index.js";

const nullLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => nullLogger,
};

interface ScriptedResult {
  readonly code: number;
  readonly stdout: string;
}

/** A context whose tool answers from a script: unknown commands fail. */
function scriptedContext(
  answers: Readonly<Record<string, ScriptedResult>>,
  seen: string[][] = [],
): CliExtensionContext {
  return {
    profile: { id: "opencode" },
    providerId: "opencode",
    logger: nullLogger,
    stateDirectory: "/tmp/opencode-usage-test",
    env: {},
    accountHome: null,
    locate: () => Promise.resolve("/usr/bin/opencode"),
    version: () => Promise.resolve("1.18.32"),
    exec: (args: string[]) => {
      seen.push(args);
      const answer = answers[args.join(" ")];
      return Promise.resolve({
        stdout: answer?.stdout ?? "",
        exit: { code: answer?.code ?? 1, stderr: answer?.code === 0 ? "" : "unknown flag" },
      });
    },
    start: () => Promise.reject(new Error("not used")),
  } as unknown as CliExtensionContext;
}

const ok = (stdout: string): ScriptedResult => ({ code: 0, stdout });
const dayJson = (tokens: number): ScriptedResult =>
  ok(JSON.stringify({ tokens: { input: tokens, output: 10 }, cost: 0.01 }));

describe("OpenCode usage reading", () => {
  it("reads day-split stats from a release that has --days", async () => {
    const snapshot = await readUsage(
      scriptedContext({
        "stats --json --days 0": dayJson(100),
        "stats --json --days 7": dayJson(500),
      }),
    );
    expect(snapshot?.state).toBe("available");
    expect(snapshot?.limits.map((limit) => limit.id)).toEqual([
      "today.tokens",
      "today.cost",
      "week.tokens",
      "week.cost",
    ]);
  });

  it("falls back to plain `stats --json` on a release without --days", async () => {
    const seen: string[][] = [];
    const snapshot = await readUsage(
      scriptedContext(
        {
          "stats --json": ok(JSON.stringify({ tokens: { input: 1000, output: 200 }, cost: 1.5 })),
        },
        seen,
      ),
    );
    expect(snapshot?.state).toBe("available");
    // One answer, shown once — never counted as both today and the week.
    expect(snapshot?.limits).toEqual([
      { id: "tokens", label: "Tokens", used: 1200, unit: "tokens" },
      { id: "cost", label: "Cost", used: 1.5, unit: "usd" },
    ]);
    expect(seen.map((args) => args.join(" "))).toContain("stats --json");
  });

  it("falls back to the plain stats table on a release without --json", async () => {
    const snapshot = await readUsage(
      scriptedContext({
        stats: ok(
          [
            "│Total Cost                                        $0.00 │",
            "│Input                                               132 │",
            "│Output                                               33 │",
          ].join("\n"),
        ),
      }),
    );
    expect(snapshot?.state).toBe("available");
    expect(snapshot?.limits).toEqual([
      { id: "tokens", label: "Tokens", used: 165, unit: "tokens" },
      { id: "cost", label: "Cost", used: 0, unit: "usd" },
    ]);
  });

  it("stays unavailable when the tool reports nothing usable", async () => {
    await expect(readUsage(scriptedContext({}))).resolves.toBeNull();
    await expect(
      readUsage(scriptedContext({ stats: ok("opencode stats\n\nshow token usage") })),
    ).resolves.toBeNull();
  });
});
