import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeTempDirectory, removeTempDirectory } from "@ai-workbench/test-support";
import { execCli } from "@ai-workbench/transport-cli";
import { parseStatus } from "../parse.js";
import { GitService } from "../service.js";

const nullLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => nullLogger,
};

async function git(cwd: string, ...args: string[]): Promise<void> {
  const { exit } = await execCli({ executablePath: "git", args, cwd });
  if (exit.code !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${exit.stderr}`);
  }
}

describe("porcelain v2 parsing", () => {
  it("reads branch, upstream and ahead/behind", () => {
    const status = parseStatus(
      [
        "# branch.oid abc123",
        "# branch.head feature/work",
        "# branch.upstream origin/feature/work",
        "# branch.ab +2 -1",
      ].join("\n"),
    );

    expect(status.branch).toBe("feature/work");
    expect(status.upstream).toBe("origin/feature/work");
    expect(status.ahead).toBe(2);
    expect(status.behind).toBe(1);
    expect(status.clean).toBe(true);
  });

  it("recognizes a detached head", () => {
    const status = parseStatus("# branch.head (detached)");
    expect(status.detached).toBe(true);
    expect(status.branch).toBeNull();
  });

  it("classifies changed, added, deleted and untracked files", () => {
    const status = parseStatus(
      [
        "1 M. N... 100644 100644 100644 aaa bbb staged.ts",
        "1 .M N... 100644 100644 100644 aaa bbb worktree.ts",
        "1 A. N... 000000 100644 100644 aaa bbb added.ts",
        "1 .D N... 100644 100644 000000 aaa bbb gone.ts",
        "? new-file.ts",
        "! ignored.ts",
      ].join("\n"),
    );

    expect(status.changes).toEqual([
      { path: "staged.ts", kind: "modified", staged: true },
      { path: "worktree.ts", kind: "modified", staged: false },
      { path: "added.ts", kind: "added", staged: true },
      { path: "gone.ts", kind: "deleted", staged: false },
      { path: "new-file.ts", kind: "untracked", staged: false },
    ]);
    expect(status.clean).toBe(false);
  });

  it("keeps the previous path of a rename", () => {
    const status = parseStatus(
      "2 R. N... 100644 100644 100644 aaa bbb R100 new/name.ts\told/name.ts",
    );
    expect(status.changes[0]).toEqual({
      path: "new/name.ts",
      kind: "renamed",
      staged: true,
      previousPath: "old/name.ts",
    });
  });

  it("handles a quoted path with a space", () => {
    const status = parseStatus('? "a file with spaces.ts"');
    expect(status.changes[0]?.path).toBe("a file with spaces.ts");
  });
});

describe("GitService against a real repository", () => {
  let directory: string;
  let service: GitService;

  beforeEach(async () => {
    directory = await makeTempDirectory("ai-workbench-git-");
    service = new GitService({ logger: nullLogger });
  });

  afterEach(async () => {
    await removeTempDirectory(directory);
  });

  it("reports a directory that is not a repository", async () => {
    const status = await service.status(directory);
    expect(status.isRepository).toBe(false);
    expect(status.branch).toBeNull();
  });

  it("reports branch and changes in a real repository", async () => {
    await git(directory, "init", "--initial-branch", "main");
    await git(directory, "config", "user.email", "test@example.com");
    await git(directory, "config", "user.name", "Test");

    await writeFile(join(directory, "README.md"), "hello\n");
    await git(directory, "add", "README.md");
    await git(directory, "commit", "-m", "first");

    const clean = await service.status(directory);
    expect(clean.isRepository).toBe(true);
    expect(clean.branch).toBe("main");
    expect(clean.clean).toBe(true);

    await writeFile(join(directory, "README.md"), "hello again\n");
    await mkdir(join(directory, "src"), { recursive: true });
    await writeFile(join(directory, "src/new.ts"), "export {};\n");

    const dirty = await service.status(directory);
    expect(dirty.clean).toBe(false);
    expect(dirty.changes).toContainEqual({
      path: "README.md",
      kind: "modified",
      staged: false,
    });
    expect(dirty.changes.some((change) => change.kind === "untracked")).toBe(true);
  });

  it("records what changed between two moments without touching the person's index", async () => {
    await git(directory, "init", "--initial-branch", "main");
    await git(directory, "config", "user.email", "test@example.com");
    await git(directory, "config", "user.name", "Test");
    await writeFile(join(directory, ".gitignore"), "build/\n");
    await writeFile(join(directory, "README.md"), "hello\n");
    await git(directory, "add", ".");
    await git(directory, "commit", "-m", "first");
    // Something the person already had going, and staged.
    await writeFile(join(directory, "notes.md"), "mine\n");
    await git(directory, "add", "notes.md");
    const before = await service.status(directory);

    const start = await service.snapshot(directory);
    expect(start).toMatch(/^[0-9a-f]{40,64}$/);

    // What a member does during its turn: an edit, a new file, a build output.
    await writeFile(join(directory, "README.md"), "hello again\n");
    await mkdir(join(directory, "src"), { recursive: true });
    await writeFile(join(directory, "src/new.ts"), "export const x = 1;\n");
    await mkdir(join(directory, "build"), { recursive: true });
    await writeFile(join(directory, "build/out.js"), "ignored\n");
    const end = await service.snapshot(directory);

    const change = await service.compare(directory, start ?? "", end ?? "");
    expect(change.files.sort()).toEqual(["README.md", "src/new.ts"]);
    expect(change.diff).toContain("+hello again");
    expect(change.diff).toContain("+export const x = 1;");
    // The person's own staged work is not part of the turn...
    expect(change.diff).not.toContain("mine");
    // ...and their index is exactly as it was: nothing added, nothing lost.
    const after = await service.status(directory);
    expect(after.changes.filter((entry) => entry.staged)).toEqual(
      before.changes.filter((entry) => entry.staged),
    );
    // The new file is still just untracked (git lists its new folder).
    expect(after.changes.some((entry) => entry.path.startsWith("src") && entry.kind === "untracked")).toBe(true);

    // Nothing changed, nothing to show.
    expect((await service.compare(directory, end ?? "", end ?? "")).files).toEqual([]);
  });

  it("records nothing in a folder that is not a repository", async () => {
    expect(await service.snapshot(directory)).toBeNull();
  });
});
