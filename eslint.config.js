import js from "@eslint/js";
import globals from "globals";

export default [
  { ignores: ["node_modules/**", "web/vendor/**", "docs/images/**"] },
  js.configs.recommended,
  {
    files: ["server/**/*.mjs", "bin/**/*.mjs", "scripts/**/*.mjs", "test/**/*.mjs", "eslint.config.js"],
    languageOptions: { ecmaVersion: 2023, sourceType: "module", globals: { ...globals.node, ...globals.browser } },
  },
  {
    files: ["web/**/*.js"],
    languageOptions: { ecmaVersion: 2023, sourceType: "module", globals: { ...globals.browser } },
  },
  {
    rules: {
      "no-unused-vars": ["warn", { args: "none", caughtErrors: "none", ignoreRestSiblings: true, varsIgnorePattern: "^_" }],
      "no-empty": ["error", { allowEmptyCatch: true }],
      "no-constant-condition": ["error", { checkLoops: false }],
      "no-control-regex": "off",
      "no-useless-escape": "warn",
      "no-prototype-builtins": "off",
      "no-undef": "error",
    },
  },
];
