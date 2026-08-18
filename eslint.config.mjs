import js from "@eslint/js";
import globals from "globals";

export default [
  js.configs.recommended,
  {
    files: ["src/**/*.mjs", "tests/**/*.mjs", "scripts/**/*.mjs"],
    languageOptions: {
      ecmaVersion: "latest", // import-attribute syntax (`with { type: "json" }`) needs this
      sourceType: "module",
      globals: {
        ...globals.node,
      },
    },
    rules: {
      "no-unused-vars": ["warn", { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" }],
      "no-console": "off",
      "prefer-const": "error",
      "no-var": "error",
      "no-undef": "error",
      "no-constant-condition": ["error", { checkLoops: false }],
    },
  },
  {
    ignores: ["node_modules/**", "coverage/**", "dist/**"],
  },
];
