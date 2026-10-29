// Tests for S-013 (K-010, K-012): signals with evidence down to selector
// and PC offset. Written first (red) per A-21; the implementation lives in
// src/domain/evidence.ts, src/domain/signals.ts and src/domain/cantTell.ts.
// All bytecode below is small hand-assembled synthetic sequences in this
// file: no real contract bytecode and no external data. Severity, direction
// and risk mappings in TEST_CATALOGUE are placeholders for the tests only;
// production values come from the versioned model artifact per K-210/A-20.
// No thresholds, weights or signature tables are used here: detection fires
// solely on structural opcode presence in the disassembly.
import { describe, expect, test } from "vitest";
import * as fc from "fast-check";
import { CodeSnippet, Evidence } from "../../../src/domain/evidence.ts";
import {
  CAPABILITY_KEYS,
  Signal,
  detectCapabilities,
} from "../../../src/domain/signals.ts";
import type {
  CapabilityCatalogue,
  Signal as SignalType,
  Temporality,
} from "../../../src/domain/signals.ts";
import {
  Address,
  Bytecode,
  CloneGroupId,
  CodeHash,
  PcOffset,
  Probability,
  Selector,
} from "../../../src/domain/types.ts";
import type { Result } from "../../../src/domain/result.ts";
import type { Bytecode as BytecodeType } from "../../../src/domain/types.ts";
import type { CodeHash as CodeHashType } from "../../../src/domain/types.ts";
import type { Evidence as EvidenceType } from "../../../src/domain/evidence.ts";

// Unwrap a Result in tests only; the domain itself never throws.
function mustOk<T, E extends { message: string }>(result: Result<T, E>): T {
  if (!result.ok) {
    throw new Error(`expected ok, got error: ${result.error.message}`);
  }
  return result.value;
}

function mustCode(hex: string): BytecodeType {
  return mustOk(Bytecode.parse(hex));
}

function codeFromBytes(bytes: readonly number[]): BytecodeType {
  const body = bytes.map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return mustCode(`0x${body}`);
}

function codeHashOf(code: BytecodeType): CodeHashType {
  return mustOk(CodeHash.of(code));
}

function rawToHex(raw: Uint8Array): string {
  return `0x${Array.from(raw, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

// Placeholder catalogue for the tests only. Production risk, direction and
// severity values come from the versioned model artifact per K-210 and A-20.
const TEST_CATALOGUE: CapabilityCatalogue = {
  selfdestruct: { risk: "rug-pull", direction: "raises", severity: "high" },
  delegatecall: { risk: "rug-pull", direction: "raises", severity: "high" },
  call: { risk: "honeypot", direction: "raises", severity: "medium" },
  "storage-write": { risk: "bot-pump", direction: "lowers", severity: "low" },
};

function testChanger(): Temporality {
  return {
    kind: "can-change",
    changer: mustOk(Address.parse("0x0102030405060708090a0b0c0d0e0f1011121314")),
  };
}

function testEvidence(code: BytecodeType): EvidenceType {
  return mustOk(
    Evidence.create({
      selector: mustOk(Selector.parse("0xa9059cbb")),
      offset: mustOk(PcOffset.of(11, code)),
    }),
  );
}

// Dispatcher window for 0xa9059cbb with jump target 10, then JUMPDEST,
// SELFDESTRUCT and STOP. PCs: DUP1@0 PUSH4@1 EQ@6 PUSH1@7 JUMPI@9
// JUMPDEST@10 SELFDESTRUCT@11 STOP@12.
function dispatcherWithSelfdestruct(): BytecodeType {
  return codeFromBytes([
    0x80, 0x63, 0xa9, 0x05, 0x9c, 0xbb, 0x14, 0x60, 0x0a, 0x57, 0x5b, 0xff, 0x00,
  ]);
}

describe("k010 signals carry selector and offset", () => {
  test("k010_signal_requires_selector_and_carries_offset_when_derivable", () => {
    const code = dispatcherWithSelfdestruct();
    const signals = detectCapabilities(code, codeHashOf(code), TEST_CATALOGUE, testChanger());
    expect(signals.length).toBeGreaterThan(0);
    for (const signal of signals) {
      expect(signal.evidence.length).toBeGreaterThan(0);
      for (const item of signal.evidence) {
        expect(item.selector).toMatch(/^0x[0-9a-f]{8}$/);
      }
    }
    // The selfdestruct capability is present: its evidence carries the
    // derivable SELFDESTRUCT opcode offset 11 beside the selector.
    const found = signals.find((signal) => signal.kind === "capability");
    expect(found).toBeDefined();
    if (found !== undefined && found.kind === "capability") {
      const offsets = found.evidence.map((item) => item.offset as number | undefined);
      expect(offsets).toContain(11);
    }
    // A signal built directly via the smart constructor keeps the same
    // selector and offset in its evidence.
    const direct = mustOk(
      Signal.createCapability({
        codeHash: codeHashOf(code),
        risk: "rug-pull",
        direction: "raises",
        severity: "high",
        temporality: testChanger(),
        evidence: [testEvidence(code)],
      }),
    );
    expect(direct.kind).toBe("capability");
    if (direct.kind === "capability") {
      expect(direct.evidence[0]?.selector).toBe("0xa9059cbb");
      expect(direct.evidence[0]?.offset).toBe(11);
    }
  });

  test("k010_signal_without_evidence_fails_construction", () => {
    const code = mustCode("0x6001");
    const codeHash = codeHashOf(code);
    const capability = Signal.createCapability({
      codeHash,
      risk: "rug-pull",
      direction: "raises",
      severity: "high",
      temporality: testChanger(),
      evidence: [],
    });
    expect(capability.ok).toBe(false);
    const clone = Signal.createCloneMatch({
      codeHash,
      risk: "honeypot",
      direction: "raises",
      severity: "medium",
      similarity: mustOk(Probability.of(0.5)),
      group: mustOk(CloneGroupId.parse("trap-group-1")),
      priorCount: 3,
      evidence: [],
    });
    expect(clone.ok).toBe(false);
    const hard = Signal.createHardToAnalyze({
      codeHash,
      risk: "rug-pull",
      cause: "obfuscated-structure",
      evidence: [],
    });
    expect(hard.ok).toBe(false);
  });

  test("k010_signal_states_direction_and_risk_type", () => {
    const code = dispatcherWithSelfdestruct();
    const signal = mustOk(
      Signal.createCapability({
        codeHash: codeHashOf(code),
        risk: "honeypot",
        direction: "lowers",
        severity: "low",
        temporality: testChanger(),
        evidence: [testEvidence(code)],
      }),
    );
    expect(signal.kind).toBe("capability");
    if (signal.kind === "capability") {
      expect(signal.direction).toBe("lowers");
      expect(signal.risk).toBe("honeypot");
    }
  });
});

describe("k010 structural detection on synthetic bytecode", () => {
  test("k010_each_structural_opcode_gives_one_capability_signal", () => {
    // One dispatcher plus SELFDESTRUCT, DELEGATECALL, CALL and SSTORE each
    // placed after the paired JUMPDEST, so every occurrence sits inside the
    // paired function body and every PC offset is honestly attributable.
    const code = codeFromBytes([
      0x80, 0x63, 0xa9, 0x05, 0x9c, 0xbb, 0x14, 0x60, 0x0a, 0x57, 0x5b,
      0xff, 0xf4, 0xf1, 0x60, 0x00, 0x55, 0x00,
    ]);
    const signals = detectCapabilities(code, codeHashOf(code), TEST_CATALOGUE, testChanger());
    expect(signals).toHaveLength(CAPABILITY_KEYS.length);
    for (const signal of signals) {
      expect(signal.kind).toBe("capability");
      expect(signal.evidence.length).toBeGreaterThan(0);
    }
  });

  test("k010_absent_opcode_gives_no_signal_for_that_capability", () => {
    // Dispatcher plus STOP only: no structural capability opcode present.
    const code = codeFromBytes([
      0x80, 0x63, 0xa9, 0x05, 0x9c, 0xbb, 0x14, 0x60, 0x0a, 0x57, 0x5b, 0x00,
    ]);
    expect(detectCapabilities(code, codeHashOf(code), TEST_CATALOGUE, testChanger())).toEqual([]);
  });

  test("k010_bytecode_without_selectors_yields_no_signals", () => {
    // A bare SELFDESTRUCT carries no dispatcher, so no selector evidence
    // can be built and the signal stays unrepresentable per A-13.
    const code = codeFromBytes([0xff, 0x00]);
    expect(detectCapabilities(code, codeHashOf(code), TEST_CATALOGUE, testChanger())).toEqual([]);
    expect(detectCapabilities(mustCode("0x"), codeHashOf(mustCode("0x")), TEST_CATALOGUE, testChanger())).toEqual(
      [],
    );
  });

  test("k010_unknown_jump_target_skips_unattributable_occurrence", () => {
    // The dispatcher target sits past the end of the code, so the selector
    // is explicitly unknown and no paired function body holds the SSTORE.
    // Honest attribution skips the occurrence instead of guessing the
    // selector: no signal, never a cited function the opcode does not sit
    // in.
    const code = codeFromBytes([
      0x80, 0x63, 0x70, 0xa0, 0x82, 0x31, 0x14, 0x60, 0xff, 0x57, 0x60, 0x00, 0x55, 0x00,
    ]);
    expect(detectCapabilities(code, codeHashOf(code), TEST_CATALOGUE, testChanger())).toEqual([]);
  });

  test("k010_signals_sorted_by_signal_id", () => {
    const code = codeFromBytes([
      0x80, 0x63, 0xa9, 0x05, 0x9c, 0xbb, 0x14, 0x60, 0x0a, 0x57, 0x5b,
      0xff, 0xf4, 0xf1, 0x60, 0x00, 0x55, 0x00,
    ]);
    const signals = detectCapabilities(code, codeHashOf(code), TEST_CATALOGUE, testChanger());
    const ids = signals.map((signal: SignalType) => signal.id as string);
    expect(ids).toEqual([...ids].sort());
  });

  test("k010_signals_sharing_a_selector_share_signal_id", () => {
    // SignalId derives from code hash and the evidence selector (A-10), so
    // two structural capabilities found beside the same selector share one
    // id; catalogue key order keeps the list deterministic on ties.
    const code = codeFromBytes([
      0x80, 0x63, 0xa9, 0x05, 0x9c, 0xbb, 0x14, 0x60, 0x0a, 0x57, 0x5b, 0xff, 0xf1, 0x00,
    ]);
    const signals = detectCapabilities(code, codeHashOf(code), TEST_CATALOGUE, testChanger());
    expect(signals).toHaveLength(2);
    expect(signals[0]?.id).toBe(signals[1]?.id);
    for (const signal of signals) {
      expect(signal.kind).toBe("capability");
      expect(signal.evidence.length).toBeGreaterThan(0);
    }
  });

  test("k010_capability_evidence_names_the_function_holding_the_opcode", () => {
    // Two-selector dispatcher: 0x06fdde03 routes to PC 48 (a body with no
    // storage use) while 0xa9059cbb routes to PC 64, and the only SSTORE
    // sits at PC 69 inside the 0xa9059cbb body. The evidence must name the
    // holding function (0xa9059cbb): pairing the occurrence with the
    // alphabetically first selector would blame a function that never
    // touches storage.
    const code = codeFromBytes([
      0x80, 0x63, 0x06, 0xfd, 0xde, 0x03, 0x14, 0x61, 0x00, 0x30, 0x57,
      0x80, 0x63, 0xa9, 0x05, 0x9c, 0xbb, 0x14, 0x61, 0x00, 0x40, 0x57,
      0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
      0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
      0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
      0x5b,
      0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
      0x00, 0x00, 0x00, 0x00, 0x00,
      0x5b,
      0x60, 0x00, 0x60, 0x00, 0x55, 0x00,
    ]);
    const signals = detectCapabilities(code, codeHashOf(code), TEST_CATALOGUE, testChanger());
    expect(signals).toHaveLength(1);
    const only = signals[0];
    expect(only?.kind).toBe("capability");
    if (only !== undefined && only.kind === "capability") {
      expect(only.evidence).toHaveLength(1);
      expect(only.evidence[0]?.selector).toBe("0xa9059cbb");
      expect(only.evidence[0]?.offset).toBe(69);
    }
  });

  test("k010_snippet_travels_with_evidence_when_given", () => {
    const code = dispatcherWithSelfdestruct();
    const snippet = mustOk(
      CodeSnippet.create({
        text: "selfdestruct(payable(owner));",
        line: 7,
        selector: mustOk(Selector.parse("0xa9059cbb")),
      }),
    );
    const signal = mustOk(
      Signal.createCapability({
        codeHash: codeHashOf(code),
        risk: "rug-pull",
        direction: "raises",
        severity: "high",
        temporality: testChanger(),
        evidence: [
          mustOk(
            Evidence.create({
              selector: mustOk(Selector.parse("0xa9059cbb")),
              offset: mustOk(PcOffset.of(11, code)),
              snippet,
            }),
          ),
        ],
      }),
    );
    if (signal.kind === "capability") {
      expect(signal.evidence[0]?.snippet?.text).toBe("selfdestruct(payable(owner));");
    } else {
      throw new Error("expected a capability signal");
    }
  });
});

describe("k010 property", () => {
  test("k010_detection_never_throws_deterministic_and_canonically_ordered", () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 400 }), (raw) => {
        const code = mustOk(Bytecode.parse(rawToHex(raw)));
        const before = Array.from(code);
        const codeHash = codeHashOf(code);
        const first = detectCapabilities(code, codeHash, TEST_CATALOGUE, testChanger());
        const second = detectCapabilities(code, codeHash, TEST_CATALOGUE, testChanger());
        // Deterministic: two runs over the same bytes agree exactly.
        expect(second).toEqual(first);
        // Canonically ordered on SignalId. Ids stay selector-scoped per
        // A-10, so distinct capabilities beside one selector share an id
        // and keep catalogue key order on ties through the stable sort.
        const ids = first.map((signal: SignalType) => signal.id as string);
        expect(ids).toEqual([...ids].sort());
        // Every signal carries selector evidence with in-range offsets.
        for (const signal of first) {
          expect(signal.evidence.length).toBeGreaterThan(0);
          for (const item of signal.evidence) {
            expect(item.selector).toMatch(/^0x[0-9a-f]{8}$/);
            if (item.offset !== undefined) {
              expect(Number.isInteger(item.offset)).toBe(true);
              expect(item.offset as number).toBeGreaterThanOrEqual(0);
              expect(item.offset as number).toBeLessThan(code.length);
            }
          }
        }
        // The analysis leaves its input unchanged.
        expect(Array.from(code)).toEqual(before);
      }),
      { seed: 10013, numRuns: 250 },
    );
  });
});
