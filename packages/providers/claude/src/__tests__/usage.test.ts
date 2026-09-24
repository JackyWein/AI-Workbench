import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeTempDirectory, removeTempDirectory } from "@ai-workbench/test-support";
import type { CliExtensionContext } from "@ai-workbench/provider-cli";
import { readTranscriptUsage, readUsage } from "../usage.js";

const nullLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => nullLogger,
};

function contextFor(home: string): CliExtensionContext {
  return {
    providerId: "claude-code",
    accountHome: home,
    env: {},
  } as unknown as CliExtensionContext;
}

function assistantLine(id: string, input: number, output: number): string {
  return JSON.stringify({
    type: "assistant",
    message: {
      id,
      usage: {
        input_tokens: input,
        output_tokens: output,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      },
    },
  });
}

describe("Claude Code transcript usage", () => {
  let home: string;

  beforeEach(async () => {
    home = await makeTempDirectory("claude-usage-");
  });

  afterEach(async () => {
    await removeTempDirectory(home);
  });

  async function writeTranscript(project: string, name: string, lines: string[]): Promise<void> {
    const directory = join(home, "projects", project);
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, name), `${lines.join("\n")}\n`, "utf8");
  }

  it("sums the token counts of the local transcripts", async () => {
    await writeTranscript("proj-a", "s1.jsonl", [
      assistantLine("msg_1", 10, 5),
      assistantLine("msg_1", 10, 40),
      JSON.stringify({ type: "user" }),
    ]);
    await writeTranscript("proj-b", "s2.jsonl", [assistantLine("msg_2", 20, 7)]);

    const totals = await readTranscriptUsage(home);
    expect(totals?.tokens).toEqual({ input: 30, output: 47 });

    const snapshot = await readUsage(contextFor(home));
    expect(snapshot).toMatchObject({
      providerId: "claude-code",
      state: "available",
      source: "cli",
    });
    expect(snapshot?.limits).toEqual([
      { id: "transcripts.tokens", label: "Tokens used", used: 77, unit: "tokens" },
    ]);
  });

  it("stays unavailable when there are no transcripts to read", async () => {
    await expect(readTranscriptUsage(home)).resolves.toBeNull();
    await expect(readUsage(contextFor(home))).resolves.toBeNull();
    await expect(
      readUsage(contextFor(join(home, "missing"))),
    ).resolves.toBeNull();
  });
});
