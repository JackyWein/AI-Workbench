import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeTempDirectory, removeTempDirectory } from "@ai-workbench/test-support";
import {
  ClaudeSkillImporter,
  MarkdownSkillImporter,
  parseFrontMatter,
  toSkillId,
} from "../importers.js";
import { DuplicateSkillError, SkillManager } from "../manager.js";
import { parseSkill, type SkillManifestInput } from "../manifest.js";

const nullLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => nullLogger,
};

function skill(id: string, overrides: Partial<SkillManifestInput> = {}): SkillManifestInput {
  return {
    schemaVersion: 1,
    id,
    name: id,
    instructions: `Instructions for ${id}`,
    ...overrides,
  };
}

describe("skill manifests", () => {
  it("fills in defaults", () => {
    const parsed = parseSkill(skill("react"));
    expect(parsed.version).toBe("1.0.0");
    expect(parsed.requiredCapabilities).toEqual([]);
    expect(parsed.source).toEqual({ kind: "builtin" });
  });

  it("rejects an id that is not usable as a folder name", () => {
    expect(() => parseSkill(skill("Not Valid"))).toThrow();
    expect(() => parseSkill({ ...skill("ok"), instructions: "" })).toThrow();
  });
});

describe("scope resolution", () => {
  let manager: SkillManager;

  beforeEach(() => {
    manager = new SkillManager({ logger: nullLogger });
    manager.register(skill("react"));
    manager.register(skill("git"));
    manager.register(skill("docker"));
  });

  it("refuses to register the same id twice", () => {
    expect(() => manager.register(skill("react"))).toThrow(DuplicateSkillError);
  });

  it("returns nothing when no scope enables anything", () => {
    expect(manager.resolve({})).toEqual([]);
  });

  it("includes skills enabled globally", () => {
    const effective = manager.resolve({
      global: [{ skillId: "react", enabled: true }],
    });
    expect(effective.map((entry) => entry.skill.id)).toEqual(["react"]);
    expect(effective[0]?.decidedBy).toBe("global");
  });

  it("lets a workspace add to the global set", () => {
    const effective = manager.resolve({
      global: [{ skillId: "react", enabled: true }],
      workspace: [{ skillId: "git", enabled: true }],
    });
    expect(effective.map((entry) => entry.skill.id)).toEqual(["git", "react"]);
  });

  it("lets a workspace switch off a global skill", () => {
    const effective = manager.resolve({
      global: [{ skillId: "react", enabled: true }],
      workspace: [{ skillId: "react", enabled: false }],
    });
    expect(effective).toEqual([]);
  });

  it("lets a session switch a skill back on", () => {
    const effective = manager.resolve({
      global: [{ skillId: "react", enabled: true }],
      workspace: [{ skillId: "react", enabled: false }],
      session: [{ skillId: "react", enabled: true }],
    });
    expect(effective.map((entry) => entry.skill.id)).toEqual(["react"]);
    expect(effective[0]?.decidedBy).toBe("session");
  });

  it("ignores a scope entry for a skill that no longer exists", () => {
    expect(manager.resolve({ session: [{ skillId: "gone", enabled: true }] })).toEqual([]);
  });

  it("drops skills the provider cannot support", () => {
    manager.upsert(skill("vision-work", { requiredCapabilities: ["vision"] }));
    const effective = manager.resolve({
      global: [
        { skillId: "react", enabled: true },
        { skillId: "vision-work", enabled: true },
      ],
    });

    const filtered = manager.filterByCapabilities(effective, {
      supported: ["chat", "streaming"],
    });
    expect(filtered.map((entry) => entry.skill.id)).toEqual(["react"]);
  });

  it("builds instructions from the effective set", () => {
    const effective = manager.resolve({
      global: [
        { skillId: "react", enabled: true },
        { skillId: "git", enabled: true },
      ],
    });
    const instructions = manager.buildInstructions(effective);

    expect(instructions).toContain("# git");
    expect(instructions).toContain("Instructions for react");
    expect(manager.buildInstructions([])).toBe("");
  });
});

describe("front matter", () => {
  it("reads attributes and keeps the body", () => {
    const { attributes, body } = parseFrontMatter(
      ['---', 'name: Code Review', 'description: "Reviews code"', '---', '', 'Do the thing.'].join("\n"),
    );
    expect(attributes["name"]).toBe("Code Review");
    expect(attributes["description"]).toBe("Reviews code");
    expect(body.trim()).toBe("Do the thing.");
  });

  it("passes through a document without front matter", () => {
    const { attributes, body } = parseFrontMatter("# Title\n\nBody");
    expect(attributes).toEqual({});
    expect(body).toBe("# Title\n\nBody");
  });

  it("turns a name into a usable id", () => {
    expect(toSkillId("Code Review!")).toBe("code-review");
    expect(toSkillId("  ")).toBe("skill");
  });
});

describe("importers", () => {
  let directory: string;

  beforeEach(async () => {
    directory = await makeTempDirectory("ai-workbench-skills-");
  });

  afterEach(async () => {
    await removeTempDirectory(directory);
  });

  it("imports Claude-style skill folders", async () => {
    await mkdir(join(directory, "code-review"), { recursive: true });
    await writeFile(
      join(directory, "code-review", "SKILL.md"),
      ['---', 'name: Code Review', 'description: Reviews changes', '---', '', 'Look for defects.'].join("\n"),
    );
    await mkdir(join(directory, "not-a-skill"), { recursive: true });

    const importer = new ClaudeSkillImporter();
    expect(await importer.canImport(directory)).toBe(true);

    const imported = await importer.import(directory);
    expect(imported).toHaveLength(1);

    const parsed = parseSkill(imported[0]);
    expect(parsed.id).toBe("code-review");
    expect(parsed.name).toBe("Code Review");
    expect(parsed.description).toBe("Reviews changes");
    expect(parsed.instructions).toBe("Look for defects.");
    expect(parsed.source.importer).toBe("claude-skill");
  });

  it("reports that it cannot import an unrelated directory", async () => {
    expect(await new ClaudeSkillImporter().canImport(directory)).toBe(false);
    expect(await new ClaudeSkillImporter().canImport(join(directory, "missing"))).toBe(
      false,
    );
  });

  it("imports plain Markdown files", async () => {
    await writeFile(
      join(directory, "docker.md"),
      "# Docker\n\nHow to work with containers.\n\nMore detail.",
    );

    const importer = new MarkdownSkillImporter();
    expect(await importer.canImport(directory)).toBe(true);

    const [imported] = await importer.import(directory);
    const parsed = parseSkill(imported);
    expect(parsed.id).toBe("docker");
    expect(parsed.name).toBe("Docker");
    expect(parsed.description).toBe("How to work with containers.");
  });

  it("imports a single Markdown file", async () => {
    const file = join(directory, "notes.md");
    await writeFile(file, "# Notes\n\nSomething useful.");
    const imported = await new MarkdownSkillImporter().import(file);
    expect(imported).toHaveLength(1);
  });

  it("imported skills go straight into the manager", async () => {
    await writeFile(join(directory, "git.md"), "# Git\n\nUse small commits.");
    const manager = new SkillManager({ logger: nullLogger });

    for (const imported of await new MarkdownSkillImporter().import(directory)) {
      manager.upsert(imported);
    }

    expect(manager.list().map((entry) => entry.id)).toEqual(["git"]);
    const effective = manager.resolve({ session: [{ skillId: "git", enabled: true }] });
    expect(manager.buildInstructions(effective)).toContain("Use small commits");
  });
});
