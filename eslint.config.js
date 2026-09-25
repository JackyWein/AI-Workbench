import js from "@eslint/js";
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "**/node_modules/**",
      "**/out/**",
      "**/dist/**",
      "packages/database/migrations/**",
      ".scratch/**",
      "brag-output/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2023,
      globals: { ...globals.node, ...globals.browser },
    },
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/consistent-type-imports": [
        "error",
        { fixStyle: "inline-type-imports" },
      ],
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "no-console": ["warn", { allow: ["error", "warn"] }],
    },
  },
  {
    files: ["apps/desktop/src/renderer/**/*.tsx"],
    plugins: { "react-hooks": reactHooks },
    rules: reactHooks.configs.recommended.rules,
  },
  {
    // A store selector must hand back the same value while the store is
    // unchanged. A fresh `[]` or `{}` on every read makes React re-render
    // until it gives up (error 185) and takes the view down with it.
    files: ["apps/desktop/src/renderer/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector:
            "CallExpression[callee.name=/^use(Workbench|Island\\w*)$/] > ArrowFunctionExpression > LogicalExpression > :matches(ArrayExpression, ObjectExpression)",
          message:
            "A store selector must not return a new array or object on each read; use a shared constant.",
        },
      ],
    },
  },
  {
    files: ["**/*.config.ts", "**/*.config.js", "**/*.test.ts"],
    rules: { "no-console": "off" },
  },
);
