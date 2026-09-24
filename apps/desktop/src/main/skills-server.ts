import { serveSkillsLibrary } from "@ai-workbench/mcp";

// The application's skills, served to every tool over MCP: a short list up
// front, a skill's full text only when an agent loads it.
const library = process.argv[2];
if (!library) {
  process.stderr.write("A skills library folder is required.\n");
  process.exitCode = 1;
} else {
  void serveSkillsLibrary(library).catch((error: unknown) => {
    process.stderr.write(`Skills library could not start: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
