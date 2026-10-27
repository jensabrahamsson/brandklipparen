// Supply-chain minimalism (K-506, M-12): the REST driving adapter validates
// input at the boundary with plain checks plus smart constructors, so no
// dedicated schema library is needed at runtime. Written first per A-21
// (red): zod is still a runtime dependency, so this test fails until zod
// is removed from dependencies.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
const packageJson = JSON.parse(
  readFileSync(join(repoRoot, "package.json"), "utf8"),
) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
const serverSource = readFileSync(
  join(repoRoot, "src", "interfaces", "rest", "server.ts"),
  "utf8",
);

describe("runtime dependency minimalism (S-032)", () => {
  test("k506_no_unneeded_runtime_dependencies", () => {
    // zod must not remain a production dependency: boundary validation in
    // the REST adapter uses plain checks plus smart constructors.
    expect(Object.keys(packageJson.dependencies ?? {})).not.toContain("zod");
    // No source file may import zod anymore.
    expect(serverSource).not.toMatch(/from\s+["']zod["']/);
  });

  test("k506_ajv_stays_a_dev_dependency", () => {
    // ajv is used only by the test suite to validate responses against the
    // published schema; it must not move into production dependencies.
    expect(Object.keys(packageJson.devDependencies ?? {})).toContain("ajv");
    expect(Object.keys(packageJson.dependencies ?? {})).not.toContain("ajv");
  });
});
