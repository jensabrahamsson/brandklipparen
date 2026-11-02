// Tests for the shared Solidity CBOR metadata footer helper (K-009, K-017).
// Written first (red) per A-21; the implementation lives in
// src/domain/metadata.ts. All byte sequences below are small hand-assembled
// synthetic values built in this file: no real contract bytecode, no
// thresholds, weights or external data.
import { describe, expect, test } from "vitest";
import {
  executableEnd,
  hasCodeAfterMetadata,
  strictCborFooterStart,
  stripCborFooter,
} from "../../../src/domain/metadata.ts";
import { extractSelectors } from "../../../src/domain/selectors.ts";
import { Bytecode, CodeHash, SkeletonHash } from "../../../src/domain/types.ts";
import type { Bytecode as BytecodeType } from "../../../src/domain/types.ts";
import type { CodeHash as CodeHashType } from "../../../src/domain/types.ts";
import type { SkeletonHash as SkeletonHashType } from "../../../src/domain/types.ts";

function mustCode(hex: string): BytecodeType {
  const parsed = Bytecode.parse(hex);
  if (!parsed.ok) {
    throw new Error(`expected valid bytecode, got error: ${parsed.error.message}`);
  }
  return parsed.value;
}

function codeFromBytes(bytes: readonly number[]): BytecodeType {
  const body = bytes.map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return mustCode(`0x${body}`);
}

function mustCodeHash(code: BytecodeType): CodeHashType {
  const parsed = CodeHash.of(code);
  if (!parsed.ok) {
    throw new Error(`expected code hash, got error: ${parsed.error.message}`);
  }
  return parsed.value;
}

function mustSkeletonHash(code: BytecodeType): SkeletonHashType {
  const parsed = SkeletonHash.of(code);
  if (!parsed.ok) {
    throw new Error(`expected skeleton hash, got error: ${parsed.error.message}`);
  }
  return parsed.value;
}

// Executable prefix shared by the footer tests: DUP1 PUSH4 0xa9059cbb EQ
// PUSH1 0x0a JUMPI JUMPDEST STOP.
const DISPATCHER: readonly number[] = [
  0x80, 0x63, 0xa9, 0x05, 0x9c, 0xbb, 0x14, 0x60, 0x0a, 0x57, 0x5b, 0x00,
];

// Standard Solidity CBOR metadata footer (53 bytes), mirroring the layout
// the old fixed-size rule recognised. The 34 content bytes carry a fake
// dispatcher window so the tests prove the footer region stays excluded.
function standardFooter(): number[] {
  const content: number[] = [
    0x80, 0x63, 0xde, 0xad, 0xbe, 0xef, 0x14, 0x60, 0x01, 0x57,
    ...new Array<number>(24).fill(0x00),
  ];
  return [
    0xa2, 0x64, 0x69, 0x70, 0x66, 0x73, 0x58, 0x22,
    ...content,
    0x64, 0x73, 0x6f, 0x6c, 0x63, 0x43, 0x00, 0x08, 0x09, 0x00, 0x33,
  ];
}

describe("k017 shared CBOR metadata footer", () => {
  test("k017_strips_standard_53_byte_footer", () => {
    const full = codeFromBytes([...DISPATCHER, ...standardFooter()]);
    const prefix = codeFromBytes([...DISPATCHER]);
    expect(Array.from(stripCborFooter(full))).toEqual([...DISPATCHER]);
    // The footer stays excluded from template identity and extraction, but
    // the code hash covers the full bytes so footer variants never share a
    // cache entry (cache-poisoning guard).
    expect(mustCodeHash(full)).not.toBe(mustCodeHash(prefix));
    expect(mustSkeletonHash(full)).toBe(mustSkeletonHash(prefix));
    expect(extractSelectors(full)).toEqual(extractSelectors(prefix));
  });

  test("k017_strips_shorter_variable_length_footer", () => {
    // Fifteen-byte blob: a strict single-pair map {experimental: true} plus
    // its length suffix. Shorter footers still parse and stay excluded.
    const key = [0x65, 0x78, 0x70, 0x65, 0x72, 0x69, 0x6d, 0x65, 0x6e, 0x74, 0x61, 0x6c];
    const blob = [0xa1, 0x6c, ...key, 0xf5];
    const full = codeFromBytes([...DISPATCHER, ...blob, 0x00, 0x0f]);
    const prefix = codeFromBytes([...DISPATCHER]);
    expect(strictCborFooterStart(full)).toBe(DISPATCHER.length);
    expect(Array.from(stripCborFooter(full))).toEqual([...DISPATCHER]);
    expect(mustCodeHash(full)).not.toBe(mustCodeHash(prefix));
    expect(mustSkeletonHash(full)).toBe(mustSkeletonHash(prefix));
    expect(hasCodeAfterMetadata(full)).toBe(false);
  });

  test("k017_strips_longer_variable_length_footer", () => {
    // Sixty-five-byte blob: a strict three-pair map {ipfs, solc,
    // experimental} showing the layout varies by compiler version and
    // settings while staying excluded.
    const hash = new Array<number>(34).fill(0x11);
    const blob = [
      0xa3,
      0x64, 0x69, 0x70, 0x66, 0x73, 0x58, 0x22, ...hash,
      0x64, 0x73, 0x6f, 0x6c, 0x63, 0x43, 0x00, 0x08, 0x09,
      0x6c, 0x65, 0x78, 0x70, 0x65, 0x72, 0x69, 0x6d, 0x65, 0x6e, 0x74, 0x61, 0x6c, 0xf5,
    ];
    const full = codeFromBytes([...DISPATCHER, ...blob, 0x00, 0x41]);
    const prefix = codeFromBytes([...DISPATCHER]);
    expect(strictCborFooterStart(full)).toBe(DISPATCHER.length);
    expect(Array.from(stripCborFooter(full))).toEqual([...DISPATCHER]);
    expect(mustCodeHash(full)).not.toBe(mustCodeHash(prefix));
    expect(mustSkeletonHash(full)).toBe(mustSkeletonHash(prefix));
    expect(hasCodeAfterMetadata(full)).toBe(false);
  });

  test("k017_indefinite_length_map_blob_leaves_code_unchanged", () => {
    // The strict rule accepts only definite maps 0xa1-0xa5: an indefinite
    // map start (0xbf) is never compiler metadata, so the code stays
    // unchanged and fully analysed instead of being cut.
    const blob = [0xbf, 0x01, 0x02, 0xff];
    const full = codeFromBytes([...DISPATCHER, ...blob, 0x00, 0x04]);
    expect(strictCborFooterStart(full)).toBe(null);
    expect(Array.from(stripCborFooter(full))).toEqual([
      ...DISPATCHER,
      ...blob,
      0x00,
      0x04,
    ]);
  });

  test("k017_non_map_key_blob_leaves_code_unchanged", () => {
    // Six-byte blob starting with a map header but carrying an integer key:
    // not a compiler metadata map, so no cut.
    const blob = [0xa1, 0x01, 0x02, 0x03, 0x04, 0x05];
    const full = codeFromBytes([...DISPATCHER, ...blob, 0x00, 0x06]);
    expect(strictCborFooterStart(full)).toBe(null);
    expect(Array.from(stripCborFooter(full))).toEqual([
      ...DISPATCHER,
      ...blob,
      0x00,
      0x06,
    ]);
  });

  test("k017_length_suffix_larger_than_code_leaves_code_unchanged", () => {
    // Suffix 0x0010 claims 16 blob bytes in 4 bytes of code.
    const bytes = [0x60, 0x01, 0x00, 0x10];
    expect(Array.from(stripCborFooter(codeFromBytes(bytes)))).toEqual(bytes);
    // A two-byte code whose suffix alone exceeds the code stays unchanged.
    const tiny = [0x60, 0x01];
    expect(Array.from(stripCborFooter(codeFromBytes(tiny)))).toEqual(tiny);
  });

  test("k017_blob_without_map_header_leaves_code_unchanged", () => {
    // Suffix 0x0003 is consistent in length, but the blob starts with 0x01,
    // which is not a CBOR map header, so the code stays unchanged.
    const bytes = [0x60, 0x01, 0x02, 0x03, 0x00, 0x03];
    expect(Array.from(stripCborFooter(codeFromBytes(bytes)))).toEqual(bytes);
    // A zero length suffix claims no blob at all.
    const zero = [0x60, 0x01, 0x00, 0x00];
    expect(Array.from(stripCborFooter(codeFromBytes(zero)))).toEqual(zero);
  });

  test("k017_empty_code_leaves_code_unchanged", () => {
    expect(Array.from(stripCborFooter(mustCode("0x")))).toEqual([]);
  });

  test("k009_variable_length_footer_excluded_from_extraction", () => {
    // The footer blob is a strict map whose 34-byte hash region carries a
    // full dispatcher window for 0x70a08231. The window must not leak into
    // extraction at a non-53 footer length.
    const window = [0x80, 0x63, 0x70, 0xa0, 0x82, 0x31, 0x14, 0x60, 0x05, 0x57];
    const hash = [...window, ...new Array<number>(24).fill(0x00)];
    const blob = [
      0xa2, 0x64, 0x69, 0x70, 0x66, 0x73, 0x58, 0x22, ...hash,
      0x64, 0x73, 0x6f, 0x6c, 0x63, 0x43, 0x00, 0x08, 0x09,
    ];
    const full = codeFromBytes([...DISPATCHER, ...blob, 0x00, 0x33]);
    expect(strictCborFooterStart(full)).toBe(DISPATCHER.length);
    expect(extractSelectors(full)).toEqual([
      { kind: "paired", selector: "0xa9059cbb", target: 10 },
    ]);
    expect(hasCodeAfterMetadata(full)).toBe(false);
  });
});

describe("c09 strict CBOR footer (F-3, part 1)", () => {
  test("c09_solc04_bzzr0_footer_stays_excluded", () => {
    // solc 0.4 shape: a strict single-pair map {bzzr0: bytes(32)}.
    const hash = new Array<number>(32).fill(0x11);
    const blob = [0xa1, 0x65, 0x62, 0x7a, 0x7a, 0x72, 0x30, 0x58, 0x20, ...hash];
    const full = codeFromBytes([...DISPATCHER, ...blob, 0x00, 0x29]);
    const prefix = codeFromBytes([...DISPATCHER]);
    expect(strictCborFooterStart(full)).toBe(DISPATCHER.length);
    expect(executableEnd(full)).toBe(DISPATCHER.length);
    expect(Array.from(stripCborFooter(full))).toEqual([...DISPATCHER]);
    expect(mustSkeletonHash(full)).toBe(mustSkeletonHash(prefix));
    expect(extractSelectors(full)).toEqual(extractSelectors(prefix));
    expect(hasCodeAfterMetadata(full)).toBe(false);
  });

  test("c09_solc08_ipfs_solc_footer_stays_excluded", () => {
    // solc 0.8 shape with different hash and version bytes than the shared
    // standard footer above: still a strict map, still excluded.
    const hash = new Array<number>(34).fill(0x22);
    const blob = [
      0xa2, 0x64, 0x69, 0x70, 0x66, 0x73, 0x58, 0x22, ...hash,
      0x64, 0x73, 0x6f, 0x6c, 0x63, 0x43, 0x00, 0x08, 0x15,
    ];
    const full = codeFromBytes([...DISPATCHER, ...blob, 0x00, 0x33]);
    const prefix = codeFromBytes([...DISPATCHER]);
    expect(strictCborFooterStart(full)).toBe(DISPATCHER.length);
    expect(executableEnd(full)).toBe(DISPATCHER.length);
    expect(Array.from(stripCborFooter(full))).toEqual([...DISPATCHER]);
    expect(mustSkeletonHash(full)).toBe(mustSkeletonHash(prefix));
    expect(extractSelectors(full)).toEqual(extractSelectors(prefix));
    expect(hasCodeAfterMetadata(full)).toBe(false);
  });

  test("c09_unknown_key_blob_leaves_code_unchanged", () => {
    // A map-shaped tail with a key the compiler never emits is not
    // metadata: the bytes stay in the analysed code.
    const blob = [0xa1, 0x64, 0x6e, 0x6f, 0x74, 0x65, 0x43, 0x01, 0x02, 0x03];
    const bytes = [...DISPATCHER, ...blob, 0x00, 0x0a];
    const full = codeFromBytes(bytes);
    expect(strictCborFooterStart(full)).toBe(null);
    expect(Array.from(stripCborFooter(full))).toEqual(bytes);
  });

  test("c09_trailing_byte_after_map_leaves_code_unchanged", () => {
    // The map values must consume exactly the blob: one trailing byte
    // means this is code that happens to end in map-shaped bytes.
    const key = [0x65, 0x78, 0x70, 0x65, 0x72, 0x69, 0x6d, 0x65, 0x6e, 0x74, 0x61, 0x6c];
    const blob = [0xa1, 0x6c, ...key, 0xf5, 0x00];
    const bytes = [...DISPATCHER, ...blob, 0x00, 0x10];
    const full = codeFromBytes(bytes);
    expect(strictCborFooterStart(full)).toBe(null);
    expect(Array.from(stripCborFooter(full))).toEqual(bytes);
  });

  // A strictly valid footer whose 34-byte hash region hides a JUMPDEST:
  // the F-3 attack shape, where the blob content is real code. The content
  // carries no dispatcher window, so extraction sees only the prefix.
  function footerHidingJumpdestAt(contentIndex: number): number[] {
    const content = new Array<number>(34).fill(0x00);
    content[contentIndex] = 0x5b;
    return [
      0xa2, 0x64, 0x69, 0x70, 0x66, 0x73, 0x58, 0x22, ...content,
      0x64, 0x73, 0x6f, 0x6c, 0x63, 0x43, 0x00, 0x08, 0x09, 0x00, 0x33,
    ];
  }

  test("c09_forged_footer_with_target_past_cut_is_not_cut", () => {
    // F-3 layout: a dispatcher entry targets a JUMPDEST hidden inside a
    // strictly valid footer, so cutting would drop real code. The cut is
    // refused, the entry keeps its target, and the shape is flagged.
    const prefixLength = 11;
    const hiddenAt = prefixLength + 8 + 2;
    const prefix = [
      0x80, 0x63, 0xa9, 0x05, 0x9c, 0xbb, 0x14,
      0x61, (hiddenAt >> 8) & 0xff, hiddenAt & 0xff, 0x57,
    ];
    const full = codeFromBytes([...prefix, ...footerHidingJumpdestAt(2)]);
    expect(strictCborFooterStart(full)).toBe(prefixLength);
    expect(executableEnd(full)).toBe(full.length);
    expect(Array.from(stripCborFooter(full))).toEqual([
      ...prefix,
      ...footerHidingJumpdestAt(2),
    ]);
    expect(extractSelectors(full)).toEqual([
      { kind: "paired", selector: "0xa9059cbb", target: hiddenAt },
    ]);
    expect(hasCodeAfterMetadata(full)).toBe(true);
  });

  test("c09_push2_jumpdest_constant_past_cut_is_not_cut", () => {
    // An internal return address pushed for a later dynamic jump names a
    // JUMPDEST hidden in the footer: the cut is refused even without a
    // dispatcher window.
    const prefixLength = 4;
    const hiddenAt = prefixLength + 8 + 2;
    const prefix = [0x00, 0x61, (hiddenAt >> 8) & 0xff, hiddenAt & 0xff];
    const full = codeFromBytes([...prefix, ...footerHidingJumpdestAt(2)]);
    expect(strictCborFooterStart(full)).toBe(prefixLength);
    expect(executableEnd(full)).toBe(full.length);
    expect(hasCodeAfterMetadata(full)).toBe(true);
  });

  test("bk03_fallthrough_into_footer_is_not_cut", () => {
    // No jump references the footer, but execution falls straight into
    // it: the last prefix instruction is not a terminator.
    const prefix = [0x5b, 0x60, 0x00];
    const full = codeFromBytes([...prefix, ...standardFooter()]);
    expect(strictCborFooterStart(full)).toBe(prefix.length);
    expect(executableEnd(full)).toBe(full.length);
    expect(hasCodeAfterMetadata(full)).toBe(true);
  });
});
