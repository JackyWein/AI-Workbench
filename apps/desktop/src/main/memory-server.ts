import { serveObsidianMemory } from "@ai-workbench/mcp";

const vault = process.argv[2];
if (!vault) {
  process.stderr.write("A vault folder is required.\n");
  process.exitCode = 1;
} else {
  void serveObsidianMemory(vault).catch((error: unknown) => {
    process.stderr.write(`Memory vault could not start: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
