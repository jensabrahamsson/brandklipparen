import { execFileSync } from "node:child_process";
import { rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

function run(command: string, args: readonly string[]): number {
  try {
    execFileSync(command, [...args], {
      cwd: repoRoot,
      stdio: "pipe",
      encoding: "utf8",
    });
    return 0;
  } catch (error) {
    const status = (error as { status?: unknown }).status;
    return typeof status === "number" ? status : 1;
  }
}

describe("CI gate enforcement", () => {
  test("a06_deliberately_broken_boundary_fails_ci", () => {
    const clean = run("npx", ["depcruise", "--validate", ".dependency-cruiser.cjs", "src/domain"]);
    expect(clean).toBe(0);

    const probe = join(repoRoot, "src", "domain", "__a06_probe__.ts");
    writeFileSync(probe, 'import fs from "node:fs";\nexport const probe = fs;\n');
    try {
      const broken = run("npx", ["depcruise", "--validate", ".dependency-cruiser.cjs", "src/domain"]);
      expect(broken).not.toBe(0);
    } finally {
      rmSync(probe, { force: true });
    }
  });

  test("k106_typecheck_blocks_on_error", () => {
    const clean = run("npx", ["tsc", "--noEmit"]);
    expect(clean).toBe(0);

    const broken = run("npx", [
      "tsc",
      "--noEmit",
      "--strict",
      "--noUncheckedIndexedAccess",
      "--exactOptionalPropertyTypes",
      "--target",
      "es2022",
      "--module",
      "nodenext",
      "--moduleResolution",
      "nodenext",
      "--skipLibCheck",
      "tests/fixtures/broken/type-error.ts",
    ]);
    expect(broken).not.toBe(0);
  });
});
