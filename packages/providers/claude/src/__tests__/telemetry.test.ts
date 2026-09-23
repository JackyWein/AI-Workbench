import { execFile } from "node:child_process";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeTempDirectory, removeTempDirectory } from "@ai-workbench/test-support";
import {
  BRIDGE_SCRIPT,
  POSIX_BRIDGE_SCRIPT,
  TranscriptTokens,
  bridgeCommand,
  posixBridgeCommand,
  findGitBash,
  findUserStatusLine,
  metricsFromStatusLine,
  writeChainScript,
} from "../telemetry.js";

/** The status line input as documented for Claude Code 2.1. */
const report = {
  session_id: "0b5f1c2e-1111-2222-3333-444455556666",
  transcript_path: "C:/Users/me/.claude/projects/x/0b5f1c2e.jsonl",
  model: { id: "claude-opus-5-5", display_name: "Opus 5.5" },
  cost: { total_cost_usd: 0.4213, total_duration_ms: 812_000, total_api_duration_ms: 90_000 },
  context_window: {
    total_input_tokens: 48_200,
    total_output_tokens: 1200,
    context_window_size: 1_000_000,
    used_percentage: 5,
  },
  rate_limits: {
    five_hour: { used_percentage: 23.5, resets_at: 1790127000 },
    seven_day: { used_percentage: 61.2, resets_at: 1790589600 },
  },
};

describe("Claude Code status line", () => {
  let directory: string;

  beforeEach(async () => {
    directory = await makeTempDirectory("claude-telemetry-");
  });

  afterEach(async () => {
    await removeTempDirectory(directory);
  });

  it("turns a report into metrics without adding anything the tool did not say", () => {
    const metrics = metricsFromStatusLine(report, undefined, new Date(0));
    expect(metrics).toEqual({
      source: "Claude Code status line",
      providerSessionId: report.session_id,
      model: "Opus 5.5",
      activeMs: 812_000,
      costUsd: 0.4213,
      costEstimated: true,
      context: { usedTokens: 48_200, windowTokens: 1_000_000 },
      limits: [
        expect.objectContaining({ id: "five_hour", used: 24, remaining: 76, unit: "percent" }),
        expect.objectContaining({ id: "seven_day", used: 61, resetsAt: new Date(1790589600 * 1000) }),
      ],
      updatedAt: new Date(0),
    });
  });

  it("leaves limits out for an account the tool reports none for", () => {
    const metrics = metricsFromStatusLine({ session_id: "s", model: { id: "m" } }, undefined, new Date(0));
    expect(metrics?.limits).toEqual([]);
    expect(metrics?.context).toBeUndefined();
    expect(metricsFromStatusLine({}, undefined, new Date(0))).toBeNull();
  });

  it("counts each response of a transcript once, with its last usage", async () => {
    const path = join(directory, "session.jsonl");
    const line = (id: string, output: number): string =>
      JSON.stringify({
        type: "assistant",
        message: {
          id,
          usage: {
            input_tokens: 10,
            output_tokens: output,
            cache_read_input_tokens: 1000,
            cache_creation_input_tokens: 50,
          },
        },
      });
    await writeFile(path, `${line("msg_1", 5)}\n${line("msg_1", 40)}\n{"type":"user"}\n`);
    const tokens = new TranscriptTokens(path);
    expect(await tokens.read()).toEqual({ input: 10, output: 40, cacheRead: 1000, cacheWrite: 50 });

    await writeFile(path, `${line("msg_1", 5)}\n${line("msg_1", 40)}\n{"type":"user"}\n${line("msg_2", 7)}\n`);
    expect(await tokens.read()).toEqual({ input: 20, output: 47, cacheRead: 2000, cacheWrite: 100 });
  });

  it("finds the status line the person configured, closest settings first", async () => {
    const home = join(directory, "home");
    const project = join(directory, "project");
    await mkdir(home, { recursive: true });
    await mkdir(join(project, ".claude"), { recursive: true });
    await writeFile(
      join(home, "settings.json"),
      JSON.stringify({ statusLine: { type: "command", command: "bash ~/line.sh", padding: 2 } }),
    );
    expect(await findUserStatusLine(project, home)).toEqual({ command: "bash ~/line.sh", padding: 2 });

    await writeFile(
      join(project, ".claude", "settings.json"),
      JSON.stringify({ statusLine: { type: "command", command: "echo project" } }),
    );
    expect(await findUserStatusLine(project, home)).toEqual({ command: "echo project" });
    expect(await findUserStatusLine(join(directory, "none"), join(directory, "nohome"))).toBeNull();
  });

  /** Runs a status line command the way Claude Code does on Windows. */
  async function runStatusLine(command: string, input: string): Promise<string> {
    const shell = findGitBash(process.env);
    const child = shell
      ? execFile(shell, ["-c", command], { encoding: "utf8" })
      : execFile("powershell", ["-NoProfile", "-Command", command], { encoding: "utf8" });
    child.stdin?.end(input);
    return new Promise<string>((resolve, reject) => {
      let text = "";
      child.stdout?.on("data", (chunk: string) => {
        text += chunk;
      });
      child.on("error", reject);
      child.on("close", () => resolve(text));
    });
  }

  it.runIf(process.platform === "win32")(
    "bridge saves the report and prints the person's own status line",
    async () => {
      const script = join(directory, "bridge.ps1");
      const output = join(directory, "out.json");
      await writeFile(script, `\uFEFF${BRIDGE_SCRIPT}`, "utf8");
      const shell = findGitBash(process.env);
      // Quotes and braces on purpose: they must reach the shell untouched.
      const chain = await writeChainScript(
        directory,
        "run1",
        { command: 'read -r line; echo "mine:${#line}"' },
        shell,
        output,
      );
      const input = JSON.stringify(report);
      const printed = await runStatusLine(bridgeCommand({ script, output, chain, shell }), input);

      expect(JSON.parse(await readFile(output, "utf8"))).toEqual(report);
      if (shell) {
        expect(printed.trim()).toBe(`mine:${input.length}`);
      }
    },
    30_000,
  );

  it.runIf(process.platform === "win32")(
    "bridge prints a compact line when the person has none",
    async () => {
      const script = join(directory, "bridge.ps1");
      const output = join(directory, "out.json");
      await writeFile(script, `\uFEFF${BRIDGE_SCRIPT}`, "utf8");
      const printed = await runStatusLine(
        bridgeCommand({ script, output, chain: null, shell: null }),
        JSON.stringify(report),
      );
      expect(printed).toBe("Opus 5.5 · 5% context · 5h 24% · week 61%");
    },
    30_000,
  );

  /** Runs a status line command the way Claude Code does on macOS and Linux. */
  async function runPosixStatusLine(command: string, input: string): Promise<string> {
    const child = execFile("/bin/sh", ["-c", command], { encoding: "utf8" });
    child.stdin?.end(input);
    return new Promise<string>((resolve, reject) => {
      let text = "";
      child.stdout?.on("data", (chunk: string) => {
        text += chunk;
      });
      child.on("error", reject);
      child.on("close", () => resolve(text));
    });
  }

  it.runIf(process.platform !== "win32")(
    "POSIX bridge saves the report and prints the person's own status line",
    async () => {
      // A space in the path on purpose: every path must survive the shell.
      const home = join(directory, "state dir");
      await mkdir(home, { recursive: true });
      const script = join(home, "bridge.sh");
      const output = join(home, "out.json");
      await writeFile(script, POSIX_BRIDGE_SCRIPT, "utf8");
      // Quotes and braces on purpose: they must reach the shell untouched.
      const chain = await writeChainScript(
        home,
        "run1",
        { command: 'read -r line; echo "mine:${#line}"' },
        "/bin/sh",
        output,
      );
      const input = JSON.stringify(report);
      const printed = await runPosixStatusLine(
        posixBridgeCommand({ script, output, chain }),
        input,
      );

      expect(JSON.parse(await readFile(output, "utf8"))).toEqual(report);
      // The person's command read exactly what Claude Code sent, byte for byte.
      expect(printed.trim()).toBe(`mine:${input.length}`);
    },
    30_000,
  );

  it.runIf(process.platform !== "win32")(
    "POSIX bridge prints nothing when the person has no status line of their own",
    async () => {
      const script = join(directory, "bridge.sh");
      const output = join(directory, "out.json");
      await writeFile(script, POSIX_BRIDGE_SCRIPT, "utf8");
      const printed = await runPosixStatusLine(
        posixBridgeCommand({ script, output, chain: null }),
        JSON.stringify(report),
      );

      // Claude Code shows no status line without one; the bridge adds none.
      expect(printed).toBe("");
      expect(JSON.parse(await readFile(output, "utf8"))).toEqual(report);
    },
    30_000,
  );

  it.runIf(process.platform !== "win32")(
    "POSIX bridge replaces the saved report as a whole, never half-written",
    async () => {
      const script = join(directory, "bridge.sh");
      const output = join(directory, "out.json");
      await writeFile(script, POSIX_BRIDGE_SCRIPT, "utf8");
      const command = posixBridgeCommand({ script, output, chain: null });

      await runPosixStatusLine(command, JSON.stringify({ ...report, session_id: "first" }));
      await runPosixStatusLine(command, JSON.stringify({ ...report, session_id: "second" }));

      expect(JSON.parse(await readFile(output, "utf8"))).toMatchObject({ session_id: "second" });
      // No temporary files are left beside it.
      expect((await readdir(directory)).filter((name) => name.includes(".tmp"))).toEqual([]);
    },
    30_000,
  );
});
