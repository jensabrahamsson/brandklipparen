import { execFileSync } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
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

  test("i03_actions_pinned_to_full_sha", () => {
    // I-03: every action reference pins a full 40-char commit SHA with a
    // version comment; tag or branch references turn the gate red.
    const workflow = readFileSync(join(repoRoot, ".github", "workflows", "ci.yml"), "utf8");
    const usesLines = workflow.split("\n").filter((line) => line.includes("uses:"));
    expect(usesLines.length).toBeGreaterThan(0);
    for (const line of usesLines) {
      expect(line).toMatch(/uses:\s*[\w-]+\/[\w-]+\@[0-9a-f]{40}\s+#\s*v\d+/);
    }
    expect(workflow).not.toMatch(/TODO.*pin/i);
  });

  test("i05_runtime_pinned_to_node22", () => {
    // I-05/A-29: the runtime is Node.js 22 LTS in .nvmrc and engines.
    // The running-major assertion holds only under CI so local drift to
    // a newer Node stays green; CI pins the runner to Node 22 instead.
    const nvmrc = readFileSync(join(repoRoot, ".nvmrc"), "utf8").trim();
    expect(nvmrc).toBe("22");
    const manifest = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as {
      engines?: { node?: string };
    };
    expect(manifest.engines?.node).toBe(">=22 <23");
    if (process.env["CI"] !== undefined) {
      expect(process.version.split(".")[0]).toBe("v22");
    }
  });

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
