import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // The S-051 example plugin ships its own tests beside the example
    // (ADR section 8), and they run in the same gate as the suite.
    include: ["tests/**/*.test.ts", "examples/**/*.test.ts"],
    environment: "node",
  },
});
