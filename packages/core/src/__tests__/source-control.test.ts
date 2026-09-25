import { execFileSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeTempDirectory, removeTempDirectory } from "@ai-workbench/test-support";
import { CredentialManager, InMemoryCredentialStorage, InMemoryEncryption } from "@ai-workbench/credentials";
import { MockProviderAdapter } from "@ai-workbench/provider-mock";
import { GitService } from "@ai-workbench/workspace-git";
import { parseCommitMessage } from "../commit-message.js";
import { GitHubService } from "../github-service.js";
import { createNullLogger } from "../logger.js";
import { ProviderManager } from "../provider-manager.js";
import { SourceControlService } from "../source-control.js";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

describe("source control for a session's folder", () => {
  let root: string;
  let work: string;
  let providers: ProviderManager;
  let control: SourceControlService;

  beforeEach(async () => {
    root = await makeTempDirectory("source-control-");
    work = join(root, "work");
    git(root, "init", "--quiet", "--initial-branch=main", work);
    git(work, "config", "user.name", "Check");
    git(work, "config", "user.email", "check@example.invalid");
    git(work, "config", "commit.gpgsign", "false");
    const logger = createNullLogger();
    providers = new ProviderManager({ logger, stateDirectory: join(root, "providers") });
    await providers.register(new MockProviderAdapter({ chunkDelayMs: 0, startupDelayMs: 0 }));
    control = new SourceControlService({
      git: new GitService({ logger }),
      github: new GitHubService({
        credentials: new CredentialManager({
          encryption: new InMemoryEncryption(),
          storage: new InMemoryCredentialStorage(),
          logger,
        }),
        logger,
      }),
      providers,
      scratchDirectory: join(root, "scratch"),
    });
  });

  afterEach(async () => {
    await providers.dispose();
    await removeTempDirectory(root);
  });

  it("stops a commit that holds a likely secret, and commits it only when told to", async () => {
    const fake = `ghp_${"Ab12Cd34Ef".repeat(4)}`;
    await writeFile(join(work, "config.ts"), `export const token = "${fake}";\n`);
    await control.stage(work, ["config.ts"]);

    const stopped = await control.commit(work, "Add config");
    expect(stopped).toEqual({
      committed: false,
      findings: [{ kind: "GitHub token", file: "config.ts", line: 1, preview: "ghp_Ab…" }],
    });
    expect(() => git(work, "rev-parse", "--verify", "HEAD")).toThrow();

    const committed = await control.commit(work, "Add config", true);
    expect(committed.committed).toBe(true);
    expect(git(work, "log", "-1", "--format=%s").trim()).toBe("Add config");
  });

  it("commits ordinary changes straight away, and refuses when nothing is staged", async () => {
    await writeFile(join(work, "notes.md"), "Notes\n");
    await expect(control.commit(work, "Nothing")).rejects.toThrow(/Nothing is staged/);
    await control.stage(work, ["notes.md"]);
    expect((await control.commit(work, "Add notes")).committed).toBe(true);
  });

  it("has the session's model suggest a message from the staged diff", async () => {
    await writeFile(join(work, "notes.md"), "Notes\n");
    await control.stage(work, ["notes.md"]);
    const message = await control.suggestMessage(work, { providerId: "mock" });
    expect(message.split("\n")[0]).toBe("Update notes.md");
  });

  it("reads a suggested message out of a fence or a label", () => {
    expect(parseCommitMessage("```\nFix the parser\n\nIt skipped blank lines.\n```")).toBe(
      "Fix the parser\n\nIt skipped blank lines.",
    );
    expect(parseCommitMessage("Commit message: Add a test  \n")).toBe("Add a test");
  });

  it("wants a pushed branch before a pull request", async () => {
    await writeFile(join(work, "notes.md"), "Notes\n");
    await control.stage(work, ["notes.md"]);
    await control.commit(work, "Add notes");
    await expect(control.openPullRequest(work, { title: "Notes" })).rejects.toThrow(/Push the branch first/);
  });
});
