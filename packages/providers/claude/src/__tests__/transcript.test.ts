import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeTempDirectory, removeTempDirectory } from "@ai-workbench/test-support";
import { claudeCodeFactory } from "../index.js";

describe("a Claude Code conversation moving to another account", () => {
  let root: string;
  let work: string;
  let home: string;

  beforeEach(async () => {
    root = await makeTempDirectory("claude-transcript-");
    work = join(root, "work");
    home = join(root, "private");
    // How Claude Code keeps a session: the transcript under the working
    // folder's project, and a folder of the same name for its subagents.
    const project = join(work, "projects", "-home-person-app");
    await mkdir(join(project, "4f1c2a9e-session", "subagents"), { recursive: true });
    await writeFile(join(project, "4f1c2a9e-session.jsonl"), '{"type":"user","message":"remember heron"}\n');
    await writeFile(join(project, "4f1c2a9e-session", "subagents", "agent-1.jsonl"), "{}\n");
    await writeFile(join(project, "other-session.jsonl"), "{}\n");
    await mkdir(home, { recursive: true });
  });

  afterEach(async () => {
    await removeTempDirectory(root);
  });

  const account = (id: string, path: string) =>
    claudeCodeFactory().create({ id, label: id, home: path });

  it("carries the conversation's file and folder into the new home, and nothing else", async () => {
    const from = account("work", work);
    const to = account("private", home);

    const transcript = await from.exportSession?.("4f1c2a9e-session");
    expect(transcript?.entries.map((entry) => entry.relative).sort()).toEqual([
      "projects/-home-person-app/4f1c2a9e-session",
      "projects/-home-person-app/4f1c2a9e-session.jsonl",
    ]);
    expect(transcript && (await to.importSession?.(transcript))).toBe(true);

    const moved = join(home, "projects", "-home-person-app");
    expect(await readFile(join(moved, "4f1c2a9e-session.jsonl"), "utf8")).toContain("remember heron");
    expect(existsSync(join(moved, "4f1c2a9e-session", "subagents", "agent-1.jsonl"))).toBe(true);
    expect(existsSync(join(moved, "other-session.jsonl"))).toBe(false);
    // The original account keeps its copy.
    expect(existsSync(join(work, "projects", "-home-person-app", "4f1c2a9e-session.jsonl"))).toBe(true);
  });

  it("never looks outside the home for an odd session id, and has nothing for an unknown one", async () => {
    const from = account("work", work);
    expect(await from.exportSession?.("../../etc/passwd")).toBeNull();
    expect(await from.exportSession?.("..")).toBeNull();
    expect(await from.exportSession?.("never-started")).toBeNull();
  });

  it("refuses a transcript of another tool or one that points outside the home", async () => {
    const to = account("private", home);
    const source = join(work, "projects", "-home-person-app", "4f1c2a9e-session.jsonl");
    expect(
      await to.importSession?.({ family: "codex", providerSessionId: "x", entries: [{ source, relative: "a.jsonl" }] }),
    ).toBe(false);
    expect(
      await to.importSession?.({
        family: "claude-code",
        providerSessionId: "x",
        entries: [{ source, relative: "../escaped.jsonl" }],
      }),
    ).toBe(false);
    expect(existsSync(join(root, "escaped.jsonl"))).toBe(false);
  });
});
