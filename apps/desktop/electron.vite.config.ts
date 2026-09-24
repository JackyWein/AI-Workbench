import { execSync } from "node:child_process";
import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "electron-vite";

const root = resolve(__dirname, "../..");

/** Workspace packages are consumed as TypeScript source and therefore bundled. */
const alias = {
  // The css subpath must be matched before the package root alias.
  "@ai-workbench/ui/controls.css": resolve(root, "packages/ui/src/controls.css"),
  "@ai-workbench/ui/tokens.css": resolve(root, "packages/ui/src/tokens.css"),
  "@ai-workbench/ui/themes.css": resolve(root, "packages/ui/src/themes.css"),
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
  "@ai-workbench/workspace-ssh": resolve(root, "packages/workspace-ssh/src/index.ts"),
  "@ai-workbench/test-support": resolve(root, "packages/test-support/src/index.ts"),
  "@ai-workbench/workspace-git": resolve(root, "packages/workspace-git/src/index.ts"),
  "@ai-workbench/credentials": resolve(root, "packages/credentials/src/index.ts"),
  "@ai-workbench/mcp": resolve(root, "packages/mcp/src/index.ts"),
  "@ai-workbench/plugins": resolve(root, "packages/plugins/src/index.ts"),
  "@ai-workbench/skills": resolve(root, "packages/skills/src/index.ts"),
  "@ai-workbench/team": resolve(root, "packages/team/src/index.ts"),
  "@ai-workbench/status": resolve(root, "packages/status/src/index.ts"),
  "@ai-workbench/terminal": resolve(root, "packages/terminal/src/index.ts"),
  "@ai-workbench/ui": resolve(root, "packages/ui/src/index.ts"),
  "@renderer": resolve(__dirname, "src/renderer"),
};

/**
 * The commit this build is made from: CI's own, else the checkout's. The app
 * compares it with the commit a release names, so a version published again
 * from a newer commit still reaches it as an update.
 */
function buildCommit(): string {
  if (process.env["GITHUB_SHA"]) {
    return process.env["GITHUB_SHA"];
  }
  try {
    return execSync("git rev-parse HEAD", { cwd: root, stdio: ["ignore", "pipe", "ignore"] })
      .toString()
      .trim();
  } catch {
    return "";
  }
}

export default defineConfig({
  main: {
    resolve: { alias },
    define: {
      __BUILD_COMMIT__: JSON.stringify(buildCommit()),
      // A Mac build signed with a Developer ID can install its own updates.
      __SIGNED_MAC__: JSON.stringify(process.platform === "darwin" && Boolean(process.env["CSC_LINK"])),
    },
    build: {
      // Only real npm dependencies are externalized, so native modules such as
      // the SQLite client load from node_modules while workspace sources and
      // every build-time package are bundled into the output.
      externalizeDeps: true,
      rollupOptions: {
        input: {
          index: resolve(__dirname, "src/main/index.ts"),
          "memory-server": resolve(__dirname, "src/main/memory-server.ts"),
        },
        // CommonJS keeps main and preload on the same module system and lets
        // the main process use __dirname to locate its bundled siblings.
        output: { format: "cjs", entryFileNames: "[name].js" },
      },
    },
  },
  preload: {
    resolve: { alias },
    build: {
      // A sandboxed preload cannot require packages from node_modules, so it is
      // fully self-contained. CommonJS on purpose: an ESM preload would force
      // sandbox: false, which is not a trade we want.
      externalizeDeps: false,
      rollupOptions: {
        input: resolve(__dirname, "src/preload/index.ts"),
        output: { format: "cjs", entryFileNames: "index.js" },
      },
    },
  },
  renderer: {
    // The main window and the Status Island are two pages of one build, so the
    // island gets the same tokens and the same bundler without a second app.
    root: resolve(__dirname, "src/renderer"),
    plugins: [react()],
    resolve: { alias },
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, "src/renderer/index.html"),
          island: resolve(__dirname, "src/renderer/island/index.html"),
        },
      },
    },
  },
});
