import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "electron-vite";

const workspacePackages = [
  "@ai-workbench/shared",
  "@ai-workbench/core",
  "@ai-workbench/database",
  "@ai-workbench/provider-base",
  "@ai-workbench/provider-mock",
  "@ai-workbench/ui",
];

const root = resolve(__dirname, "../..");

/** Workspace packages are consumed as TypeScript source and therefore bundled. */
const alias = {
  // The css subpath must be matched before the package root alias.
  "@ai-workbench/ui/tokens.css": resolve(root, "packages/ui/src/tokens.css"),
  "@ai-workbench/shared": resolve(root, "packages/shared/src/index.ts"),
  "@ai-workbench/core": resolve(root, "packages/core/src/index.ts"),
  "@ai-workbench/database": resolve(root, "packages/database/src/index.ts"),
  "@ai-workbench/provider-base": resolve(root, "packages/providers/base/src/index.ts"),
  "@ai-workbench/provider-mock": resolve(root, "packages/providers/mock/src/index.ts"),
  "@ai-workbench/ui": resolve(root, "packages/ui/src/index.ts"),
  "@renderer": resolve(__dirname, "src/renderer"),
};

export default defineConfig({
  main: {
    resolve: { alias },
    build: {
      // Runtime dependencies stay external so native modules such as the
      // SQLite client load from node_modules; workspace sources are bundled.
      externalizeDeps: { exclude: workspacePackages },
      rollupOptions: {
        input: resolve(__dirname, "src/main/index.ts"),
        // CommonJS keeps main and preload on the same module system and lets
        // the main process use __dirname to locate its bundled siblings.
        output: { format: "cjs", entryFileNames: "index.js" },
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
    root: resolve(__dirname, "src/renderer"),
    plugins: [react()],
    resolve: { alias },
    build: {
      rollupOptions: { input: resolve(__dirname, "src/renderer/index.html") },
    },
  },
});
