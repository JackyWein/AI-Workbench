import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  TerminalLimitError,
  TerminalManager,
  TerminalNotFoundError,
} from "../manager.js";

const isWindows = process.platform === "win32";
/** The shell and commands differ per platform; the manager does not. */
const shell = isWindows ? "cmd.exe" : "/bin/sh";
const printWorkingDirectory = isWindows ? "cd\r\n" : "pwd\n";
const echoCommand = isWindows ? "echo terminal-works\r\n" : "echo terminal-works\n";
const exitWithCode = isWindows ? "exit 7\r\n" : "exit 7\n";

const nullLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => nullLogger,
};

/** Waits until the collected output satisfies a predicate, or times out. */
async function waitFor(
  read: () => string,
  predicate: (value: string) => boolean,
  timeoutMs = 5000,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = read();
    if (predicate(value)) {
      return value;
    }
    if (Date.now() > deadline) {
      throw new Error(`Timed out waiting for output. Got: ${JSON.stringify(value)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

describe("TerminalManager", () => {
  let directory: string;
  let output: string;
  let exits: Array<{ id: string; code: number }>;
  let manager: TerminalManager;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "ai-workbench-terminal-"));
    output = "";
    exits = [];
    manager = new TerminalManager({
      logger: nullLogger,
      onData: (_id, chunk) => {
        output += chunk;
      },
      onExit: (id, code) => exits.push({ id, code }),
      maxTerminals: 2,
    });
  });

  afterEach(async () => {
    manager.closeAll();
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  it("starts a shell in the session's working directory", async () => {
    const info = manager.create({
      sessionId: "s1",
      cwd: directory,
      shell,
    });

    expect(info.sessionId).toBe("s1");
    expect(info.cwd).toBe(directory);
    expect(manager.has(info.id)).toBe(true);

    manager.write(info.id, printWorkingDirectory);
    // Windows may print a shortened form of the path, so the unique directory
    // name is what gets compared rather than the whole path.
    const marker = directory.split(/[\\/]/).filter(Boolean).at(-1) ?? directory;
    const seen = await waitFor(
      () => output,
      (value) => value.includes(marker),
    );
    expect(seen).toContain(marker);
  });

  it("streams command output back", async () => {
    const info = manager.create({ sessionId: "s1", cwd: directory, shell });

    manager.write(info.id, echoCommand);
    await waitFor(
      () => output,
      (value) => value.includes("terminal-works"),
    );
  });

  it.skipIf(isWindows)("applies a resize to the running shell", async () => {
    const info = manager.create({
      sessionId: "s1",
      cwd: directory,
      shell,
      cols: 80,
      rows: 24,
    });

    manager.resize(info.id, 120, 40);
    expect(manager.list("s1")[0]).toMatchObject({ cols: 120, rows: 40 });

    // The shell itself sees the new size.
    manager.write(info.id, "tput cols 2>/dev/null || echo 120\n");
    await waitFor(
      () => output,
      (value) => value.includes("120"),
    );
  });

  it("clamps an unreasonable resize", async () => {
    const info = manager.create({ sessionId: "s1", cwd: directory, shell });
    manager.resize(info.id, 0, -5);
    expect(manager.list()[0]).toMatchObject({ cols: 1, rows: 1 });
  });

  it("reports an exit and forgets the terminal", async () => {
    const info = manager.create({ sessionId: "s1", cwd: directory, shell });

    manager.write(info.id, exitWithCode);
    await waitFor(
      () => String(exits.length),
      (value) => value !== "0",
    );

    expect(exits[0]).toMatchObject({ id: info.id, code: 7 });
    expect(manager.has(info.id)).toBe(false);
  });

  it("closes a terminal on request", async () => {
    const info = manager.create({ sessionId: "s1", cwd: directory, shell });
    expect(manager.close(info.id)).toBe(true);
    expect(manager.has(info.id)).toBe(false);
    expect(manager.close(info.id)).toBe(false);
  });

  it("keeps terminals of different sessions apart", async () => {
    const first = manager.create({ sessionId: "s1", cwd: directory, shell });
    manager.create({ sessionId: "s2", cwd: directory, shell });

    expect(manager.list("s1").map((info) => info.id)).toEqual([first.id]);
    expect(manager.list()).toHaveLength(2);

    manager.closeAll("s1");
    expect(manager.list()).toHaveLength(1);
  });

  it("refuses more terminals than the limit", () => {
    manager.create({ sessionId: "s1", cwd: directory, shell });
    manager.create({ sessionId: "s1", cwd: directory, shell });
    expect(() =>
      manager.create({ sessionId: "s1", cwd: directory, shell }),
    ).toThrow(TerminalLimitError);
  });

  it("rejects operations on an unknown terminal", () => {
    expect(() => manager.write("nope", "x")).toThrow(TerminalNotFoundError);
    expect(() => manager.resize("nope", 10, 10)).toThrow(TerminalNotFoundError);
  });

  it("does not resize when nothing changed", () => {
    const info = manager.create({
      sessionId: "s1",
      cwd: directory,
      shell,
      cols: 80,
      rows: 24,
    });
    const spy = vi.spyOn(manager, "resize");
    manager.resize(info.id, 80, 24);
    expect(spy).toHaveReturned();
    expect(manager.list()[0]).toMatchObject({ cols: 80, rows: 24 });
  });
});
