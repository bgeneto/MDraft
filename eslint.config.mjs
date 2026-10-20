import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: ["bin/**", "dist/**", "node_modules/**", "src-tauri/**"],
  },
  {
    files: ["src/**/*.{ts,js}"],
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: {
        ...globals.browser,
      },
    },
    rules: {
      // `tsc --noEmit` owns unused locals and parameters; duplicating the rule
      // here only makes the two disagree. `any` is deliberate at the parse5
      // boundary in the paste readers.
      "no-unused-vars": "off",
      "@typescript-eslint/no-unused-vars": "off",
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-empty-object-type": "off",
      "@typescript-eslint/no-require-imports": "off",
      // Browser globals are declared above; TypeScript knows the rest.
      "no-undef": "off",
      eqeqeq: ["error", "always", { null: "ignore" }],
      "no-eval": "error",
      "no-implied-eval": "error",
      "no-new-func": "error",
      "no-prototype-builtins": "error",
      "no-script-url": "error",
      "prefer-const": "error",
      "no-var": "error",
    },
  },
  {
    // This file is inlined into arbitrary HTML documents and deliberately keeps
    // the ES5 syntax an older document may need. Its runtime is the guest
    // webview, not the application bundle.
    files: ["src/html-bridge.js"],
    rules: {
      "no-var": "off",
      "prefer-const": "off",
    },
  },
);
