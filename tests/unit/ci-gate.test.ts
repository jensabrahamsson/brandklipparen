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

// Process-spawning gate tests carry an explicit timeout well above the
// default 5000 ms: CI runners are slower (cold cache, shared CPU) and the
// k106 gate took 5-6.5 s there as the project grew. 30 s keeps the gate
// green on slow runners without hiding a hung child process.
const GATE_TIMEOUT_MS = 30_000;

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
  }, GATE_TIMEOUT_MS);

  test("k106_typecheck_blocks_on_error", () => {
    // Type-check only the small fixtures with dedicated minimal tsconfigs,
    // not the whole project: the whole-project check grows with the repo
    // and tripped the default 5000 ms timeout on CI (5-6.5 s). The full
    // `tsc --noEmit` still runs as its own CI step; this test proves the
    // gate mechanism itself blocks on a type error. Both fixture configs
    // mirror the strict flags of the root tsconfig so the check stays real.
    const clean = run("npx", ["tsc", "-p", join("tests", "fixtures", "typecheck", "tsconfig.json")]);
    expect(clean).toBe(0);

    const broken = run("npx", ["tsc", "-p", join("tests", "fixtures", "broken", "tsconfig.json")]);
    expect(broken).not.toBe(0);
  }, GATE_TIMEOUT_MS);
});
