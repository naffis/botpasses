// @ts-check
import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "node_modules/**",
      "site/**",
      "coverage/**",
      "docs/**",
      ".cursor/**",
      ".claude/**",
      "bin/**",
      "eslint.config.js",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    files: ["src/**/*.ts", "test/**/*.ts", "scripts/**/*.ts"],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-floating-promises": [
        "error",
        {
          // node:test registers a test and returns a promise the runner owns; a bare
          // top-level `test(...)` is the documented pattern and is not a lost rejection.
          allowForKnownSafeCalls: [
            { from: "package", package: "node:test", name: ["test", "describe", "it", "suite"] },
          ],
        },
      ],
      "@typescript-eslint/switch-exhaustiveness-check": "error",
      // Store rows are Record<string, unknown>; `x == null ? null : String(x)` narrows to `{}`
      // and this rule flags every mapper column. The values are TEXT columns, not objects.
      "@typescript-eslint/no-base-to-string": "off",
      // Values are unknown by design in this codebase (unvalidated JSON bodies, DB rows);
      // narrowing happens at the call site. These rules would only add casts.
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-argument": "off",
      "@typescript-eslint/no-unsafe-return": "off",
      "@typescript-eslint/no-unsafe-call": "off",
      "@typescript-eslint/restrict-template-expressions": ["error", { allowNumber: true, allowBoolean: true }],
      "@typescript-eslint/require-await": "off",
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", caughtErrors: "none" }],
    },
  },
);
