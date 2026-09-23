import { chmod, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeTempDirectory, removeTempDirectory } from "@ai-workbench/test-support";
import { ProviderError } from "@ai-workbench/provider-base";
import { extractVersion, findExecutable, probeVersion } from "../discovery.js";
import { AsyncQueue, LineAssembler } from "../lines.js";
import { execCli, startCli } from "../process.js";
import { CliTransport } from "../transport.js";

const fixtures = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const streamCli = join(fixtures, "stream-cli.mjs");

const nullLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => nullLogger,
};

async function collect(lines: AsyncIterable<string>): Promise<string[]> {
  const out: string[] = [];
  for await (const line of lines) {
    out.push(line);
  }
  return out;
}

describe("LineAssembler", () => {
  it("joins lines split across chunk boundaries", () => {
    const assembler = new LineAssembler();
    expect(assembler.push("hel")).toEqual([]);
    expect(assembler.push("lo\nwor")).toEqual(["hello"]);
    expect(assembler.push("ld\n")).toEqual(["world"]);
    expect(assembler.flush()).toEqual([]);
  });

  it("returns a trailing line that has no newline", () => {
    const assembler = new LineAssembler();
    expect(assembler.push("only")).toEqual([]);
    expect(assembler.flush()).toEqual(["only"]);
  });

  it("handles carriage returns and blank lines", () => {
    const assembler = new LineAssembler();
    expect(assembler.push("a\r\n\r\nb\n")).toEqual(["a", "b"]);
  });
});

describe("AsyncQueue", () => {
  it("delivers items pushed before and after consumption starts", async () => {
    const queue = new AsyncQueue<number>();
    queue.push(1);

    const consumed: number[] = [];
    const consumer = (async () => {
      for await (const value of queue) {
        consumed.push(value);
      }
    })();

    queue.push(2);
    await new Promise((resolve) => setTimeout(resolve, 10));
    queue.push(3);
    queue.close();
    await consumer;

    expect(consumed).toEqual([1, 2, 3]);
  });

  it("surfaces a failure to the consumer", async () => {
    const queue = new AsyncQueue<number>();
    const consumer = collectNumbers(queue);
    queue.fail(new Error("stream broke"));
    await expect(consumer).rejects.toThrow("stream broke");
  });
});

async function collectNumbers(queue: AsyncIterable<number>): Promise<number[]> {
  const out: number[] = [];
  for await (const value of queue) {
    out.push(value);
  }
  return out;
}

describe("startCli", () => {
  it("streams stdout as complete lines and reports a clean exit", async () => {
    const run = startCli({
      executablePath: process.execPath,
      args: [streamCli, "--lines", "3"],
    });

    expect(await collect(run.lines)).toEqual(["line 1", "line 2", "line 3"]);
    const exit = await run.completion;
    expect(exit.code).toBe(0);
    expect(exit.cancelled).toBe(false);
    expect(exit.timedOut).toBe(false);
  });

  it("passes stdin to the process", async () => {
    const run = startCli({
      executablePath: process.execPath,
      args: [streamCli, "--lines", "1", "--echo-stdin"],
      stdin: "hello from the host",
    });

    expect(await collect(run.lines)).toEqual(["stdin:hello from the host", "line 1"]);
  });

  it("tells the process its own folder in PWD, not the application's", async () => {
    // OpenCode takes PWD before its working folder; an inherited PWD made it
    // work in the folder the application was started from.
    const folder = await makeTempDirectory("cli-pwd-");
    try {
      const run = startCli({
        executablePath: process.execPath,
        args: ["-e", "process.stdout.write(`${process.env.PWD}\\n`)"],
        cwd: folder,
        env: { PWD: "/where/the/app/started" },
      });
      expect(await collect(run.lines)).toEqual([folder]);
    } finally {
      await removeTempDirectory(folder);
    }
  });

  it("captures stderr and a non-zero exit code", async () => {
    const run = startCli({
      executablePath: process.execPath,
      args: [streamCli, "--fail"],
    });

    expect(await collect(run.lines)).toEqual([]);
    const exit = await run.completion;
    expect(exit.code).toBe(3);
    expect(exit.stderr).toContain("something went wrong");
  });

  it("terminates a process on cancel", async () => {
    const run = startCli({
      executablePath: process.execPath,
      args: [streamCli, "--hang"],
      killGraceMs: 200,
    });

    setTimeout(() => run.cancel(), 50);
    const exit = await run.completion;

    expect(exit.cancelled).toBe(true);
    expect(exit.signal ?? "").not.toBe("");
  });

  it("terminates a process that exceeds its timeout", async () => {
    const run = startCli({
      executablePath: process.execPath,
      args: [streamCli, "--hang"],
      timeoutMs: 120,
      killGraceMs: 200,
    });

    const exit = await run.completion;
    expect(exit.timedOut).toBe(true);
  });

  it("reports a missing executable instead of hanging", async () => {
    const run = startCli({
      executablePath: join(fixtures, "does-not-exist"),
      args: [],
    });

    await expect(run.completion).rejects.toThrow(/Failed to start/);
    await expect(collect(run.lines)).rejects.toThrow(/Failed to start/);
  });

  it("buffers output when executed rather than streamed", async () => {
    const { stdout, exit } = await execCli({
      executablePath: process.execPath,
      args: [streamCli, "--lines", "2"],
    });
    expect(stdout).toBe("line 1\nline 2");
    expect(exit.code).toBe(0);
  });
});

describe("executable discovery", () => {
  let directory: string;

  beforeEach(async () => {
    directory = await makeTempDirectory("ai-workbench-path-");
  });

  afterEach(async () => {
    await removeTempDirectory(directory);
  });

  it("finds an executable on PATH", async () => {
    // Windows decides by extension (PATHEXT), POSIX by the executable bit.
    const isWindows = process.platform === "win32";
    const fileName = isWindows ? "demo-cli.cmd" : "demo-cli";
    const executable = join(directory, fileName);
    await writeFile(executable, isWindows ? "@echo hi\r\n" : "#!/bin/sh\necho hi\n");
    if (!isWindows) {
      await chmod(executable, 0o755);
    }

    const found = await findExecutable("demo-cli", {
      env: { PATH: directory, PATHEXT: ".COM;.EXE;.BAT;.CMD" },
    });
    // The extension comes from PATHEXT and keeps its casing, which need not
    // match the file on disk; Windows paths are case-insensitive.
    expect(found?.source).toBe("path");
    expect(found?.path.toLowerCase()).toBe(executable.toLowerCase());
  });

  it.skipIf(process.platform === "win32")(
    "ignores a file on PATH that is not executable",
    async () => {
      await writeFile(join(directory, "demo-cli"), "not executable");
      const found = await findExecutable("demo-cli", { env: { PATH: directory } });
      expect(found).toBeNull();
    },
  );

  it("returns null when the command is nowhere on PATH", async () => {
    expect(await findExecutable("definitely-not-here", { env: { PATH: directory } })).toBeNull();
  });

  it("prefers an explicitly configured path", async () => {
    const found = await findExecutable("ignored", { configuredPath: streamCli });
    expect(found).toEqual({ path: streamCli, source: "configured" });
  });

  it("reports a configured path that does not exist", async () => {
    const found = await findExecutable("ignored", {
      configuredPath: join(directory, "missing"),
    });
    expect(found).toBeNull();
  });

  it("reads a version from the CLI", async () => {
    const probe = await probeVersion(process.execPath, [streamCli, "--version"]);
    expect(probe.ok).toBe(true);
    expect(probe.version).toBe("2.4.1");
  });

  it("extracts versions from typical output shapes", () => {
    expect(extractVersion("tool 1.2.3")).toBe("1.2.3");
    expect(extractVersion("v0.9")).toBe("0.9");
    expect(extractVersion("2.0.0-beta.1")).toBe("2.0.0-beta.1");
    expect(extractVersion("no numbers here")).toBeNull();
  });
});

describe("CliTransport", () => {
  it("locates, health checks and runs a configured executable", async () => {
    const transport = new CliTransport({
      command: "node",
      configuredPath: process.execPath,
      baseArgs: [streamCli],
      logger: nullLogger,
    });

    expect(await transport.locate()).toBe(process.execPath);
    expect(await transport.healthCheck(["--version"])).toBe(true);

    const run = await transport.start({ args: ["--lines", "2"] });
    expect(await collect(run.lines)).toEqual(["line 1", "line 2"]);
  });

  it("raises a normalized error when the executable is missing", async () => {
    const transport = new CliTransport({
      command: "definitely-not-installed-anywhere",
      logger: nullLogger,
    });

    expect(await transport.locate()).toBeNull();
    expect(await transport.healthCheck()).toBe(false);
    await expect(transport.start({ args: [] })).rejects.toBeInstanceOf(ProviderError);
    await expect(transport.start({ args: [] })).rejects.toThrow(/was not found/);
  });
});
