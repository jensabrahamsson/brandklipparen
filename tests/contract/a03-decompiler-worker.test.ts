// S-102 decompiler worker (K-008, K-501): the adapter runs the binary
// through its `decompile` subcommand with parsed output files, one process
// per request under a concurrency semaphore and a memory bound. Written
// first (red) per A-21: the adapter speaks stdout JSON only. The stub
// stands in for the real binary by copying a recorded output directory
// into the adapter-owned output dir; no network, no real binary.
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { extdecompAdapter } from "../../src/adapters/extdecomp/extdecompAdapter.ts";
import { BlockNumber, Bytecode, CodeHash, RequestId, Timestamp } from "../../src/domain/types.ts";
import type { Result } from "../../src/domain/result.ts";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..");
const stubPath = join(repoRoot, "tests", "fixtures", "extdecomp", "copy-recorded-worker.mjs");
const recordedDir = join(repoRoot, "tests", "fixtures", "extdecomp", "recorded-output");

const BYTECODE = "0x8063a9059cbb1461005b576370a0823114600a575b5bff";

function mustOk<T, E>(result: Result<T, E>): T {
  if (!result.ok) {
    throw new Error("fixture value must parse");
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

describe("decompiler worker invocation (S-102)", () => {
  test(
    "a03_main_wires_decompiler_worker",
    async () => {
      const adapter = new extdecompAdapter({
        binaryPath: process.execPath,
        binaryArgs: [stubPath, `--from=${recordedDir}`, "--delay-ms=800"],
        timeoutMs: 15000,
        maxOutputBytes: 65536,
        maxBytesIn: 24576,
        maxMemoryMb: 512,
        maxConcurrency: 1,
      });
      expect(adapter.limits().maxConcurrency).toBe(1);
      const bytecode = mustOk(Bytecode.parse(BYTECODE));
      const codeHash = mustOk(CodeHash.of(bytecode));
      const started = Date.now();
      const [first, second] = await Promise.all([
        adapter.decompile(bytecode, codeHash, fixedContext()),
        adapter.decompile(bytecode, codeHash, fixedContext()),
      ]);
      const elapsed = Date.now() - started;
      // The recorded output directory parses to the two recorded
      // functions on both runs.
      for (const result of [first, second]) {
        if (!result.ok) {
          throw new Error(`expected ok, got ${(result as { error: { kind: string } }).error.kind}`);
        }
        const selectors = result.value.functions.map((fn) => fn.selector as string).sort();
        expect(selectors).toEqual(["0x70a08231", "0xa9059cbb"]);
        for (const fn of result.value.functions) {
          expect(fn.snippet.text.length).toBeGreaterThan(0);
          expect(fn.snippet.selector as string).toBe(fn.selector as string);
        }
      }
      // Capped concurrency: two overlapping runs under maxConcurrency 1
      // serialize behind the semaphore and take at least twice the stub
      // delay instead of finishing side by side.
      expect(elapsed).toBeGreaterThanOrEqual(1500);
    },
    30000,
  );
});
