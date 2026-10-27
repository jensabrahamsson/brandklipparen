// ESLint flat config with typescript-eslint.
// The rule block for src/domain keeps the core pure: no node: modules and
// no ambient platform globals (A-06, A-32). Deliberately broken fixtures
// stay outside linting so they can fail the gate tests on purpose.
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "node_modules/**",
      "**/dist/**",
      "coverage/**",
      "apps/web/test-results/**",
      "apps/web/playwright-report/**",
      "tests/fixtures/broken/**",
    ],
  },
  ...tseslint.configs.recommended,
  {
    files: ["src/domain/**/*.ts"],
    rules: {
      "no-restricted-imports": ["error", { patterns: ["node:*"] }],
      "no-restricted-globals": ["error", "process", "fetch", "XMLHttpRequest", "WebSocket"],
    },
  },
  {
    files: ["src/application/**/*.ts", "src/ports/**/*.ts"],
    rules: {
      "no-restricted-imports": ["error", { patterns: ["node:*"] }],
      "no-restricted-globals": ["error", "process", "fetch", "XMLHttpRequest", "WebSocket"],
    },
  },
  {
    files: ["src/plugins/**/*.ts"],
    rules: {
      "no-restricted-imports": ["error", { patterns: ["node:*"] }],
      "no-restricted-globals": ["error", "process", "fetch", "XMLHttpRequest", "WebSocket"],
    },
  },
);
