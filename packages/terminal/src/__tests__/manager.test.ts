import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeTempDirectory, removeTempDirectory } from "@ai-workbench/test-support";
import {
  TerminalLimitError,
  TerminalManager,
  lastTitle,
  saysSomething,
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
    directory = await makeTempDirectory("ai-workbench-terminal-");
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
    await removeTempDirectory(directory);
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

  it("hands a program its own folder in PWD, not the application's", async () => {
    // OpenCode reads PWD before its working folder; inherited from the
    // application it pointed at the folder the application started in.
    const info = manager.create({
      sessionId: "s1",
      cwd: directory,
      command: {
        file: process.execPath,
        args: ["-e", "process.stdout.write('pwd=' + process.env.PWD + '\\n')"],
      },
      env: { PWD: "/where/the/app/started" },
    });
    expect(info.cwd).toBe(directory);
    const seen = await waitFor(
      () => output,
      (value) => value.includes("pwd="),
    );
    const marker = directory.split(/[\\/]/).filter(Boolean).at(-1) ?? directory;
    expect(seen).toContain(marker);
    expect(seen).not.toContain("/where/the/app/started");
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
    // A terminal closed by an earlier test can report its exit late, so this
    // waits for the one belonging to this terminal rather than for any exit.
    await waitFor(
      () => exits.map((exit) => exit.id).join(","),
      (value) => value.includes(info.id),
    );

    // ConPTY does not forward the shell's own exit code, so only POSIX can
    // assert the value. What the manager owes on every platform is the same:
    // report the exit for that terminal, with a code, and forget it.
    const exit = exits.find((entry) => entry.id === info.id);
    expect(exit).toBeDefined();
    expect(typeof exit?.code).toBe("number");
    if (!isWindows) {
      expect(exit?.code).toBe(7);
    }
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

  it("keeps recent output so a view can reattach to a running shell", async () => {
    const info = manager.create({ sessionId: "s1", cwd: directory, shell });

    manager.write(info.id, echoCommand);
    await waitFor(
      () => manager.scrollback(info.id),
      (value) => value.includes("terminal-works"),
    );

    // Attaching again returns the same shell together with what it printed.
    const attached = manager.attach({ sessionId: "s1", cwd: directory, shell });
    expect(attached.info.id).toBe(info.id);
    expect(attached.scrollback).toContain("terminal-works");
    expect(manager.list()).toHaveLength(1);
  });

  it("starts a shell when attaching to a session without one", () => {
    const attached = manager.attach({ sessionId: "fresh", cwd: directory, shell });
    expect(attached.scrollback).toBe("");
    expect(manager.has(attached.info.id)).toBe(true);
  });

  it("bounds the scrollback it keeps", async () => {
    const small = new TerminalManager({
      logger: nullLogger,
      onData: () => {},
      onExit: () => {},
      scrollbackLimit: 64,
    });
    try {
      const info = small.create({ sessionId: "s1", cwd: directory, shell });
      small.write(info.id, isWindows ? "echo aaaaaaaaaa\r\n" : "echo aaaaaaaaaa\n");
      await waitFor(
        () => small.scrollback(info.id),
        (value) => value.length > 0,
      );
      expect(small.scrollback(info.id).length).toBeLessThanOrEqual(64);
    } finally {
      small.closeAll();
    }
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

describe("what a terminal's program says about itself", () => {
  it("reads the window title a program sets, ended either way", () => {
    expect(lastTitle("\x1b]0;✳ Refactor the parser\x07")).toBe("✳ Refactor the parser");
    expect(lastTitle("text\x1b]2;opencode\x1b\\more")).toBe("opencode");
    // The last one in a chunk wins; a chunk without one says nothing.
    expect(lastTitle("\x1b]2;first\x07\x1b]2;second\x07")).toBe("second");
    expect(lastTitle("plain output\r\n")).toBeNull();
    // Other OSC sequences (hyperlinks, colours) are not titles.
    expect(lastTitle("\x1b]8;;https://example.com\x07link\x1b]8;;\x07")).toBeNull();
  });

  it("ignores a window title that only names the program's file", () => {
    expect(saysSomething("C:\\Windows\\system32\\cmd.exe")).toBe(false);
    expect(saysSomething("C:/Users/jacky/AppData/Local/agy/bin/agy.exe")).toBe(false);
    expect(saysSomething("\\\\server\\share\\tool")).toBe(false);
    expect(saysSomething("agy.exe")).toBe(false);
    expect(saysSomething("✳ Fix the checkout rounding")).toBe(true);
  });
});
