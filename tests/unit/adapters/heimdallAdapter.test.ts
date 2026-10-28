// extdecomp adapter over the real extdecomp 0.9.1 output format.
// Real `extdecomp decompile` writes `abi.json` as a standard ABI array
// (`[{type, name, inputs, outputs, stateMutability}, ...]`, unresolved
// selectors as `Unresolved_<hex>` names) and no `decompiled.sol` unless
// `--include-sol` is passed. The adapter must derive selectors from that
// array: hex from `Unresolved_` names, keccak256 of the canonical
// signature for resolved names, skipping non-function entries.
// The `real-format/abi.json` fixture is byte-exact output captured by
// running the real extdecomp 0.9.1 binary on synthetic dispatcher bytecode
// (three selectors; two unresolved, one resolved `name` with no inputs).
// No addresses appear anywhere: selectors only. Process-spawning tests
// carry a 30 s timeout for slow CI runners.
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { extdecompAdapter } from "../../../src/adapters/extdecomp/extdecompAdapter.ts";
import { BlockNumber, Bytecode, CodeHash, RequestId, Timestamp } from "../../../src/domain/types.ts";
import type { Result } from "../../../src/domain/result.ts";

const PROCESS_TIMEOUT_MS = 30000;

const here = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(here, "..", "..", "fixtures", "extdecomp");
const copyWorkerPath = join(fixturesDir, "copy-recorded-worker.mjs");
const fakeWorkerPath = join(fixturesDir, "fake-worker.mjs");
const realFormatDir = join(fixturesDir, "real-format");

// Synthetic dispatcher bytecode only: PUSH4 with a known selector so the
// fake worker has something to report.
const SYNTHETIC_DISPATCHER = "0x8063a9059cbb1461005b57ff";

function mustOk<T, E>(result: Result<T, E>): T {
  if (!result.ok) {
    throw new Error(`expected ok, got error: ${(result.error as { message?: string }).message}`);
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

describe("extdecomp adapter over the real 0.9.1 ABI array", () => {
  test(
    "parses_a_captured_real_format_sample_with_unresolved_and_resolved_names",
    async () => {
      const adapter = new extdecompAdapter({
        binaryPath: process.execPath,
        binaryArgs: [copyWorkerPath, `--from=${realFormatDir}`, "--delay-ms=10"],
        timeoutMs: 15000,
        maxOutputBytes: 65536,
      });
      const bytecode = mustOk(Bytecode.parse(SYNTHETIC_DISPATCHER));
      const codeHash = mustOk(CodeHash.of(bytecode));
      const result = await adapter.decompile(bytecode, codeHash, fixedContext());
      if (!result.ok) {
        throw new Error(`expected ok, got ${(result.error as { kind: string }).kind}`);
      }
      // Two `Unresolved_<hex>` names plus resolved `name()` (keccak256 of
      // `name()` is 0x06fdde03). Sorted for a stable comparison.
      const selectors = result.value.functions
        .map((fn) => fn.selector as string)
        .sort();
      expect(selectors).toEqual(["0x06fdde03", "0x70a08231", "0xa9059cbb"]);
      for (const fn of result.value.functions) {
        expect(fn.snippet.text.length).toBeGreaterThan(0);
        expect(fn.snippet.selector as string).toBe(fn.selector as string);
        expect(Number.isInteger(fn.snippet.line) && fn.snippet.line >= 0).toBe(true);
      }
    },
    PROCESS_TIMEOUT_MS,
  );

  test(
    "derives_resolved_names_via_signature_hash_and_ignores_events",
    async () => {
      const adapter = new extdecompAdapter({
        binaryPath: process.execPath,
        binaryArgs: [fakeWorkerPath, "--mode=success"],
        timeoutMs: 15000,
        maxOutputBytes: 65536,
      });
      const bytecode = mustOk(Bytecode.parse(SYNTHETIC_DISPATCHER));
      const codeHash = mustOk(CodeHash.of(bytecode));
      const result = await adapter.decompile(bytecode, codeHash, fixedContext());
      if (!result.ok) {
        throw new Error(`expected ok, got ${(result.error as { kind: string }).kind}`);
      }
      // The fake worker reports 0xa9059cbb under its resolved name
      // `transfer(address,uint256)` beside an event entry: only the
      // function survives, with the keccak-derived selector.
      const selectors = result.value.functions.map((fn) => fn.selector as string);
      expect(selectors).toEqual(["0xa9059cbb"]);
    },
    PROCESS_TIMEOUT_MS,
  );

  test(
    "rejects_a_malformed_function_entry_as_invalid_output",
    async () => {
      const adapter = new extdecompAdapter({
        binaryPath: process.execPath,
        binaryArgs: [fakeWorkerPath, "--mode=bad-entry"],
        timeoutMs: 15000,
        maxOutputBytes: 65536,
      });
      const bytecode = mustOk(Bytecode.parse(SYNTHETIC_DISPATCHER));
      const codeHash = mustOk(CodeHash.of(bytecode));
      const result = await adapter.decompile(bytecode, codeHash, fixedContext());
      expect(result.ok).toBe(false);
      if (result.ok) {
        return;
      }
      expect(result.error.kind).toBe("invalid-output");
    },
    PROCESS_TIMEOUT_MS,
  );
});
