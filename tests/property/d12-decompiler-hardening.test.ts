// Corpus expansion and boundary hardening (S-084, K-037, K-501, D-03,
// D-12). Written first per A-21 (red): no test exercises mutated bytecode
// yet. Every run over mutated input must end in a structured result, a
// labelled unstructured fallback or a typed error — never a hang, a panic,
// or a guessed jump target — within the per-port limits (A-17). A
// non-token input decompiles to plain pseudo-Solidity with zero
// token-pattern annotations and no error (D-01).
import { describe, expect, test } from "vitest";
import * as fc from "fast-check";
import { Bytecode } from "../../src/domain/types.ts";
import { buildCfg, lift } from "../../src/domain/evmLift.ts";
import { decompileContract, validatePseudoSolidity } from "../../src/domain/evmSsa.ts";
import { canonicalSerialize } from "../../src/domain/serialize.ts";

function hexOf(bytes: Uint8Array): string {
  return `0x${[...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

describe("d12_pathological_bytecode_yields_typed_outcome_or_labelled_fallback", () => {
  test("mutated bytecode decompiles to a bounded, proven result without throwing", () => {
    fc.assert(
      fc.property(fc.uint8Array({ minLength: 0, maxLength: 400 }), (bytes) => {
        const parsed = Bytecode.parse(hexOf(bytes));
        if (!parsed.ok) {
          expect(parsed.error.kind).toBe("invalid-bytecode");
          return;
        }
        const bytecode = parsed.value;
        // Must terminate: the stopping rules bound every walk.
        const first = decompileContract(bytecode);
        const second = decompileContract(bytecode);
        expect(canonicalSerialize(first as never)).toBe(canonicalSerialize(second as never));

        // Every edge targets a proven block index: never a guessed target.
        const cfg = buildCfg(lift(bytecode));
        for (const block of cfg.blocks) {
          for (const edge of block.successors) {
            expect(edge.to).toBeGreaterThanOrEqual(0);
            expect(edge.to).toBeLessThan(cfg.blocks.length);
            if (edge.kind === "conditional") {
              expect(edge.fallThrough).toBeGreaterThanOrEqual(0);
              expect(edge.fallThrough).toBeLessThan(cfg.blocks.length);
            }
          }
        }
        // Unresolved jumps are recorded with in-bounds PCs, never dropped.
        for (const jump of cfg.unresolvedJumps) {
          expect(jump.atPc).toBeGreaterThanOrEqual(0);
          expect(jump.atPc).toBeLessThan(Math.max(bytecode.length, 1));
        }
        // Every emitted range stays inside the bytecode it was lifted from.
        for (const fn of first.functions) {
          expect(fn.range.startPc).toBeGreaterThanOrEqual(0);
          expect(fn.range.endPc).toBeLessThanOrEqual(bytecode.length);
          expect(fn.range.startPc).toBeLessThanOrEqual(fn.range.endPc);
          for (const statement of fn.statements) {
            expect(statement.range.startPc).toBeGreaterThanOrEqual(fn.range.startPc);
            expect(statement.range.endPc).toBeLessThanOrEqual(fn.range.endPc);
          }
        }
        // Emission is well-formed exactly when it is non-empty.
        if (first.functions.length === 0) {
          expect(first.text).toBe("");
        } else {
          expect(validatePseudoSolidity(first.text).ok).toBe(true);
        }
      }),
      { numRuns: 100 },
    );
  });
});

describe("d12_non_erc20_input_decompiles_without_token_annotations", () => {
  test("selector-less bytecode emits plain output with zero annotations and no error", () => {
    const parsed = Bytecode.parse("0x6001600055");
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) {
      return;
    }
    const decompiled = decompileContract(parsed.value);
    expect(decompiled.functions).toEqual([]);
    expect(decompiled.text).toBe("");
    expect(decompiled.text).not.toContain("token-pattern");
  });
});
