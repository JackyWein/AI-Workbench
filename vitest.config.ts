import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

const root = import.meta.dirname;

export default defineConfig({
  resolve: {
    alias: {
      "@ai-workbench/shared": resolve(root, "packages/shared/src/index.ts"),
      "@ai-workbench/core": resolve(root, "packages/core/src/index.ts"),
      "@ai-workbench/database": resolve(root, "packages/database/src/index.ts"),
      "@ai-workbench/provider-base": resolve(root, "packages/providers/base/src/index.ts"),
      "@ai-workbench/provider-mock": resolve(root, "packages/providers/mock/src/index.ts"),
      "@ai-workbench/provider-cli": resolve(root, "packages/providers/cli/src/index.ts"),
      "@ai-workbench/provider-claude": resolve(root, "packages/providers/claude/src/index.ts"),
      "@ai-workbench/provider-codex": resolve(root, "packages/providers/codex/src/index.ts"),
      "@ai-workbench/provider-opencode": resolve(root, "packages/providers/opencode/src/index.ts"),
      "@ai-workbench/provider-gemini": resolve(root, "packages/providers/gemini/src/index.ts"),
      "@ai-workbench/transport-cli": resolve(
        root,
        "packages/providers/transports/cli/src/index.ts",
      ),
      "@ai-workbench/workspace-fs": resolve(root, "packages/workspace-fs/src/index.ts"),
      "@ai-workbench/workspace-git": resolve(root, "packages/workspace-git/src/index.ts"),
      "@ai-workbench/credentials": resolve(root, "packages/credentials/src/index.ts"),
      "@ai-workbench/mcp": resolve(root, "packages/mcp/src/index.ts"),
      "@ai-workbench/plugins": resolve(root, "packages/plugins/src/index.ts"),
      "@ai-workbench/skills": resolve(root, "packages/skills/src/index.ts"),
      "@ai-workbench/status": resolve(root, "packages/status/src/index.ts"),
      "@ai-workbench/team": resolve(root, "packages/team/src/index.ts"),
      "@ai-workbench/terminal": resolve(root, "packages/terminal/src/index.ts"),
      "@ai-workbench/test-support": resolve(root, "packages/test-support/src/index.ts"),
      "@ai-workbench/ui": resolve(root, "packages/ui/src/index.ts"),
    },
  },
  test: {
    environment: "node",
    include: ["packages/**/*.test.ts", "apps/**/*.test.ts"],
    reporters: ["default"],
    /*
     * These are integration tests: they open databases, spawn shells and run
     * command line tools. A Windows CI runner takes seconds over what a Linux
     * one does in milliseconds, so the budget is set for the slowest machine
     * the suite has to pass on rather than the fastest.
     */
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
