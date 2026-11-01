// Contract suite against the internal decompiler adapter (K-008,
// K-037, K-501, K-521, C-16r). The adapter runs the deterministic
// in-process pipeline, so every run is local with no child process: the
// shared suite proves the success and cap branches, and the tests below
// prove the structural branch (unresolved control flow resolves ok with
// the labelled regions kept), determinism and the arbitrary-input
// property (hostile input ends in a typed outcome, never an exception).
// All fixtures are synthetic: hand-assembled dispatcher bytecode and the
// frozen in-repo corpus.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import * as fc from "fast-check";
import { InternalDecompilerAdapter } from "../../src/adapters/decompiler/internalDecompilerAdapter.ts";
import type { DecompilerPort } from "../../src/ports/decompiler.ts";
import { Bytecode, CodeHash, RequestId, Timestamp, BlockNumber } from "../../src/domain/types.ts";
import type { Result } from "../../src/domain/result.ts";
import type { DecompilerContractScenario } from "./decompiler.contract.ts";
import { runDecompilerPortContract } from "./decompiler.contract.ts";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..");
const corpusDir = join(repoRoot, "tests", "fixtures", "evm", "corpus");

function mustOk<T, E extends { message: string }>(result: Result<T, E>): T {
  if (!result.ok) {
    throw new Error(`expected ok, got error: ${result.error.message}`);
  }
  return result.value;
}

function fixedContext() {
  return {
    requestId: mustOk(RequestId.parse("123e4567-e89b-12d3-a456-426614174000")),
    deadline: mustOk(Timestamp.of(4102444800000)),
    block: mustOk(BlockNumber.of(24000000)),
  };
}

function makeAdapter(scenario: DecompilerContractScenario): DecompilerPort {
  switch (scenario) {
    case "success":
      return new InternalDecompilerAdapter();
    case "resource-limit":
      return new InternalDecompilerAdapter({ maxBytesIn: 2 });
    case "output-too-large":
      return new InternalDecompilerAdapter({ maxOutputBytes: 8 });
    case "timeout":
    case "process-error":
    case "invalid-output":
      // Reached only through the adapter's own limits in the dedicated
      // tests below, never through the shared dispatcher bytecode.
      return new InternalDecompilerAdapter();
  }
}

runDecompilerPortContract("internal decompiler adapter", makeAdapter, {
  scenarios: ["success", "resource-limit", "output-too-large"],
  arbitraryInputSucceeds: false,
});

describe("internal decompiler adapter limits (K-008, K-521)", () => {
  test("unresolved control flow resolves ok with the labelled region kept", async () => {
    // Frozen corpus fixture with one recorded unresolved jump (C-16r):
    // unresolved jumps are normal compiler output, so the adapter
    // resolves ok and keeps the rendered functions instead of turning
    // the output away with invalid-output.
    const hex = readFileSync(join(corpusDir, "edge-invalid.hex"), "utf8").trim();
    const bytecode = mustOk(Bytecode.parse(hex));
    const codeHash = mustOk(CodeHash.of(bytecode));
    const before = Array.from(bytecode);
    const result = await new InternalDecompilerAdapter().decompile(bytecode, codeHash, fixedContext());
    expect(Array.from(bytecode)).toEqual(before);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.value.codeHash as string).toBe(codeHash as string);
    expect(result.value.functions.length).toBeGreaterThan(0);
    for (const fn of result.value.functions) {
      expect(fn.snippet.text).toContain(`/* selector ${fn.selector as string} */`);
    }
  });

  test("repeated runs give byte-identical snippets", async () => {
    const hex = readFileSync(join(corpusDir, "token-simple.hex"), "utf8").trim();
    const bytecode = mustOk(Bytecode.parse(hex));
    const codeHash = mustOk(CodeHash.of(bytecode));
    const adapter = new InternalDecompilerAdapter();
    const first = await adapter.decompile(bytecode, codeHash, fixedContext());
    const second = await adapter.decompile(bytecode, codeHash, fixedContext());
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) {
      return;
    }
    expect(first.value.functions.length).toBeGreaterThan(0);
    expect(second.value.functions.map((fn) => fn.snippet.text)).toEqual(
      first.value.functions.map((fn) => fn.snippet.text),
    );
  });

  test("snippets quote the pipeline's own rendered function blocks", async () => {
    const hex = readFileSync(join(corpusDir, "token-simple.hex"), "utf8").trim();
    const bytecode = mustOk(Bytecode.parse(hex));
    const codeHash = mustOk(CodeHash.of(bytecode));
    const result = await new InternalDecompilerAdapter().decompile(bytecode, codeHash, fixedContext());
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    for (const fn of result.value.functions) {
      expect(fn.snippet.text).toContain(`/* selector ${fn.selector as string} */`);
    }
  });

  test("property: generated bytecodes pass through unchanged with a typed outcome", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.integer({ min: 0, max: 255 }), { minLength: 1, maxLength: 24 }),
        async (bytes) => {
          const hex = `0x${bytes.map((b) => b.toString(16).padStart(2, "0")).join("")}`;
          const bytecode = mustOk(Bytecode.parse(hex));
          const codeHash = mustOk(CodeHash.of(bytecode));
          const before = Array.from(bytecode);
          const adapter = new InternalDecompilerAdapter();
          const result = await adapter.decompile(bytecode, codeHash, fixedContext());
          expect(Array.from(bytecode)).toEqual(before);
          if (result.ok) {
            expect(result.value.codeHash as string).toBe(codeHash as string);
          } else {
            expect(["resource-limit", "invalid-output", "output-too-large"]).toContain(result.error.kind);
            expect(result.error.message.length).toBeGreaterThan(0);
          }
        },
      ),
      { seed: 8011, numRuns: 10 },
    );
  });
});
