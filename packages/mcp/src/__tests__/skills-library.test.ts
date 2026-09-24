import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { makeTempDirectory, removeTempDirectory } from "@ai-workbench/test-support";
import { createSkillsServer, writeSkillsLibrary } from "../skills-library.js";

function textOf(result: unknown): string {
  const content = (result as { content?: Array<{ text?: string }> }).content ?? [];
  return content.map((entry) => entry.text ?? "").join("");
}

describe("skills on demand", () => {
  let directory = "";
  afterEach(async () => {
    if (directory) await removeTempDirectory(directory);
  });

  it("announces the skills that are on, loads one when asked and keeps to its folder", async () => {
    directory = await makeTempDirectory("ai-workbench-skills-library-");
    const source = join(directory, "source", "pdf");
    await mkdir(join(source, "scripts"), { recursive: true });
    await writeFile(join(source, "scripts", "fill.py"), "print('fill')\n");
    await writeFile(join(directory, "secret.txt"), "not for agents\n");
    const library = join(directory, "library");
    await writeSkillsLibrary(library, [
      { id: "pdf", name: "pdf", description: "Work with PDF files", instructions: "Use scripts/fill.py.", enabled: true, folder: source },
      { id: "draft", name: "draft", description: "Not switched on", instructions: "Hidden until enabled.", enabled: false },
    ]);

    const server = await createSkillsServer(library);
    const client = new Client({ name: "check", version: "1" }, { capabilities: {} });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      // Only a line per skill up front, and only the ones switched on.
      const instructions = client.getInstructions() ?? "";
      expect(instructions).toContain("- pdf: Work with PDF files");
      expect(instructions).not.toContain("draft");
      expect(instructions).not.toContain("Use scripts/fill.py");

      const read = textOf(await client.callTool({ name: "skill_read", arguments: { name: "PDF" } }));
      expect(read).toContain("Use scripts/fill.py.");

      const file = textOf(await client.callTool({ name: "skill_file", arguments: { name: "pdf", path: "scripts/fill.py" } }));
      expect(file).toContain("print('fill')");

      const outside = await client.callTool({ name: "skill_file", arguments: { name: "pdf", path: "../../secret.txt" } });
      expect(outside.isError).toBe(true);
      expect(textOf(outside)).not.toContain("not for agents");

      const missing = await client.callTool({ name: "skill_read", arguments: { name: "nope" } });
      expect(missing.isError).toBe(true);

      expect(textOf(await client.callTool({ name: "skill_list", arguments: {} }))).toContain("draft (off)");
    } finally {
      await client.close();
    }
  });

  it("drops a skill's folder from the library once the skill is gone", async () => {
    directory = await makeTempDirectory("ai-workbench-skills-library-");
    const library = join(directory, "library");
    await writeSkillsLibrary(library, [
      { id: "one", name: "one", description: "", instructions: "One.", enabled: true },
      { id: "two", name: "two", description: "", instructions: "Two.", enabled: true },
    ]);
    await writeSkillsLibrary(library, [{ id: "one", name: "one", description: "", instructions: "One.", enabled: true }]);
    const server = await createSkillsServer(library);
    const client = new Client({ name: "check", version: "1" }, { capabilities: {} });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      expect((await client.callTool({ name: "skill_read", arguments: { name: "two" } })).isError).toBe(true);
    } finally {
      await client.close();
    }
  });
});
