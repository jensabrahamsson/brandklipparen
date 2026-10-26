// K-102 golden and cross-process determinism tests (S-003).
// Golden fixtures under tests/fixtures/golden carry synthetic made-up
// inputs only and frozen expected bytes; tests read them and never
// regenerate them. The child-process runner lives in tests/helpers.
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { canonicalSerialize } from "../../src/domain/serialize.ts";
import {
  goldenDir,
  listGoldenInputs,
  readGoldenExpected,
  readGoldenInput,
} from "../helpers/k102-fixtures.ts";

const here = dirname(fileURLToPath(import.meta.url));
const runnerPath = join(here, "..", "helpers", "k102-run-canonical.ts");

function runCoreInChildProcess(inputName: string): Buffer {
  return execFileSync(
    process.execPath,
    ["--experimental-strip-types", runnerPath, join(goldenDir, inputName)],
    { encoding: "buffer", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 16 * 1024 * 1024 },
  );
}

describe("k102 deterministic core", () => {
  test("k102_golden_fixtures_bit_identical", () => {
    const inputs = listGoldenInputs();
    expect(inputs.length).toBeGreaterThan(0);
    for (const name of inputs) {
      const actual = Buffer.from(canonicalSerialize(readGoldenInput(name)), "utf8");
      expect(actual.equals(readGoldenExpected(name)), `fixture ${name} differs`).toBe(true);
    }
  });

  test("k102_two_runs_across_processes_bit_identical", () => {
    const inputs = listGoldenInputs();
    expect(inputs.length).toBeGreaterThan(0);
    for (const name of inputs) {
      const first = runCoreInChildProcess(name);
      const second = runCoreInChildProcess(name);
      expect(first.equals(second), `fixture ${name} differs across processes`).toBe(true);
      expect(first.equals(readGoldenExpected(name)), `fixture ${name} differs`).toBe(true);
    }
  });
});
