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
      "@ai-workbench/transport-cli": resolve(
        root,
        "packages/providers/transports/cli/src/index.ts",
      ),
      "@ai-workbench/ui": resolve(root, "packages/ui/src/index.ts"),
    },
  },
  test: {
    environment: "node",
    include: ["packages/**/*.test.ts", "apps/**/*.test.ts"],
    reporters: ["default"],
  },
});
