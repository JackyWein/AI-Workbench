import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeTempDirectory, removeTempDirectory } from "@ai-workbench/test-support";
import { findSkills } from "../skills.js";

describe("finding the skills a tool keeps", () => {
  let directory: string;

  beforeEach(async () => {
    directory = await makeTempDirectory("tool-skills-");
  });

  afterEach(async () => {
    await removeTempDirectory(directory);
  });

  it("lists each folder with a SKILL.md, named by its front matter", async () => {
    await mkdir(join(directory, "skills", "reviews"), { recursive: true });
    await writeFile(
      join(directory, "skills", "reviews", "SKILL.md"),
      "---\nname: Careful reviews\ndescription: \"Use when reviewing\"\n---\nRead it all.\n",
    );
    await mkdir(join(directory, "skills", "plain"), { recursive: true });
    await writeFile(join(directory, "skills", "plain", "SKILL.md"), "No front matter here.\n");
    // The tool's own built-ins and folders without a SKILL.md are not skills to import.
    await mkdir(join(directory, "skills", ".system", "imagegen"), { recursive: true });
    await writeFile(join(directory, "skills", ".system", "imagegen", "SKILL.md"), "---\nname: x\n---\ny\n");
    await mkdir(join(directory, "skills", "empty"), { recursive: true });

    const found = await findSkills([
      { path: join(directory, "skills"), source: "your skills" },
      { path: join(directory, "missing"), source: "nowhere" },
    ]);
    expect(found.map(({ name, description, source }) => ({ name, description, source })).sort((a, b) => a.name.localeCompare(b.name))).toEqual([
      { name: "Careful reviews", description: "Use when reviewing", source: "your skills" },
      { name: "plain", description: "", source: "your skills" },
    ]);
  });
});
