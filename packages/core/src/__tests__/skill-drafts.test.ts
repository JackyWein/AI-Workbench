import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeTempDirectory, removeTempDirectory } from "@ai-workbench/test-support";
import { MockProviderAdapter } from "@ai-workbench/provider-mock";
import { createNullLogger } from "../logger.js";
import { ProviderManager } from "../provider-manager.js";
import { draftPrompt, draftSkill, parseDraft } from "../skill-drafter.js";

describe("reading a drafted skill", () => {
  it("takes the SKILL.md form, even inside a code fence after a sentence", () => {
    const answer = [
      "Here is the skill:",
      "```markdown",
      "---",
      "name: Careful reviews",
      "description: Use when reviewing a pull request",
      "---",
      "1. Read the whole change first.",
      "2. Security before style.",
      "```",
    ].join("\n");
    expect(parseDraft(answer, "reviews")).toEqual({
      name: "Careful reviews",
      description: "Use when reviewing a pull request",
      instructions: "1. Read the whole change first.\n2. Security before style.",
    });
  });

  it("keeps an answer that ignored the form, as the instructions", () => {
    expect(parseDraft("Always run the tests before committing.", "run tests before commits")).toEqual({
      name: "Run tests before commits",
      description: "",
      instructions: "Always run the tests before committing.",
    });
  });

  it("asks for the form and for no tools", () => {
    const prompt = draftPrompt("Review pull requests");
    expect(prompt).toContain("Review pull requests");
    expect(prompt).toContain("name:");
    expect(prompt).toContain("Do not use any tools");
  });
});

describe("drafting with a provider", () => {
  let directory: string;
  let providers: ProviderManager;

  beforeEach(async () => {
    directory = await makeTempDirectory("skill-draft-");
    providers = new ProviderManager({ logger: createNullLogger(), stateDirectory: join(directory, "providers") });
    await providers.register(new MockProviderAdapter({ chunkDelayMs: 0, startupDelayMs: 0 }));
  });

  afterEach(async () => {
    await providers.dispose();
    await removeTempDirectory(directory);
  });

  it("runs one turn in a folder of its own and leaves nothing behind", async () => {
    const draft = await draftSkill(providers, { providerId: "mock", request: "Write good commit messages" }, join(directory, "drafts"));
    // The mock answers in its own words, which become the instructions.
    expect(draft.instructions).toContain("Mock response");
    expect(draft.name).toBe("Write good commit messages");
    expect((await import("node:fs")).readdirSync(join(directory, "drafts"))).toEqual([]);
  });

  it("says when the provider is not there", async () => {
    await expect(
      draftSkill(providers, { providerId: "missing", request: "anything" }, join(directory, "drafts")),
    ).rejects.toThrow(/not available/);
  });
});
