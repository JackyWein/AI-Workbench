import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeTempDirectory, removeTempDirectory } from "@ai-workbench/test-support";
import { TerminalManager } from "../manager.js";

/*
 * A real program in a real terminal (a pty; ConPTY on Windows) that shows a
 * dialog the way coding tools do and reads its own arrow keys — what the
 * island answers for a tool whose own reports do not reach the application.
 */

const DIALOG = `
const options = ["Yes, run command", "Yes, and always allow in this conversation", "No, cancel"];
const moves = process.argv[2] !== "stuck";
let selected = 0;
process.stdin.setRawMode(true);
process.stdin.setEncoding("utf8");
process.stdin.resume();
function draw(first) {
  if (!first) process.stdout.write("\\x1b[" + (options.length + 2) + "A");
  process.stdout.write("\\r\\x1b[2KRun this command?\\r\\n");
  options.forEach((option, index) =>
    process.stdout.write("\\r\\x1b[2K" + (index === selected ? "> " : "  ") + (index + 1) + ". " + option + "\\r\\n"));
  process.stdout.write("\\r\\x1b[2K  Navigate with the arrows · esc to cancel\\r\\n");
}
process.stdout.write("Requesting permission for:\\r\\n   node -c server.js\\r\\n\\r\\n");
draw(true);
process.stdin.on("data", (key) => {
  if (key === "\\r") {
    process.stdout.write("chose " + (selected + 1) + "\\r\\n");
    // Stay alive until TerminalManager closes the pty. Exiting just before
    // close() races node-pty's Windows process-list cleanup.
    return;
  }
  if (!moves) return;
  if (key === "\\x1b[A" || key === "\\x1bOA") selected = Math.max(0, selected - 1);
  if (key === "\\x1b[B" || key === "\\x1bOB") selected = Math.min(options.length - 1, selected + 1);
  draw(false);
});
`;

const nullLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => nullLogger,
};

async function until<T>(read: () => Promise<T> | T, ok: (value: T) => boolean, ms = 10_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await read();
    if (ok(value) || Date.now() > deadline) {
      return value;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

describe("a dialog in a real terminal", () => {
  let directory: string;
  let script: string;
  let output: string;
  let manager: TerminalManager;

  beforeEach(async () => {
    directory = await makeTempDirectory("ai-workbench-dialog-");
    script = join(directory, "dialog.cjs");
    await writeFile(script, DIALOG, "utf8");
    output = "";
    manager = new TerminalManager({
      logger: nullLogger,
      onData: (_id, chunk) => {
        output += chunk;
      },
      onExit: () => {},
    });
  });

  afterEach(async () => {
    manager.closeAll();
    await removeTempDirectory(directory);
  });

  const start = (mode = "moves"): string =>
    manager.create({
      sessionId: "s",
      cwd: directory,
      cols: 100,
      rows: 24,
      command: { file: process.execPath, args: [script, mode] },
    }).id;

  it("is read from the screen and answered with the program's own keys", async () => {
    const id = start();
    const prompt = await until(() => manager.prompt(id), (value) => value !== null);
    expect(prompt).toMatchObject({
      question: "Run this command?",
      context: "node -c server.js",
      selected: 0,
      permission: true,
    });
    expect(prompt?.options.map((option) => option.label)).toEqual([
      "Yes, run command",
      "Yes, and always allow in this conversation",
      "No, cancel",
    ]);

    expect(await manager.choose(id, prompt?.fingerprint ?? "", 2)).toBe(true);
    const done = await until(() => output, (value) => value.includes("chose"));
    expect(done).toContain("chose 3");
  });

  it("chooses nothing when the dialog on screen is not the one answered", async () => {
    const id = start();
    await until(() => manager.prompt(id), (value) => value !== null);
    expect(await manager.choose(id, "another dialog", 1)).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(output).not.toContain("chose");
  });

  it("never presses Enter when the marker does not move to the option", async () => {
    const id = start("stuck");
    const prompt = await until(() => manager.prompt(id), (value) => value !== null);
    expect(await manager.choose(id, prompt?.fingerprint ?? "", 1)).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(output).not.toContain("chose");
  });
});
