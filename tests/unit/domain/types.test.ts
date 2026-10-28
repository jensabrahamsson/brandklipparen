// Tests for S-002 (K-106): branded domain types with smart constructors.
// Written first (red) per A-21; the implementation lives in src/domain/types.ts.
import { describe, expect, expectTypeOf, test } from "vitest";
import * as fc from "fast-check";
import type { Result } from "../../../src/domain/result.ts";
import {
  Address,
  ArtifactChecksum,
  Bytecode,
  BlockNumber,
  CacheKey,
  CallData,
  ChainId,
  CloneGroupId,
  CodeHash,
  EvidenceId,
  ExplanationSchemaVersion,
  IndexVersion,
  ModelId,
  ModelVersion,
  PageSize,
  PcOffset,
  Probability,
  PromptVersion,
  RequestId,
  RiskScore,
  Selector,
  SignalId,
  SkeletonHash,
  Slot,
  StorageWord,
  TemplateVersion,
  Timestamp,
  UntrustedText,
} from "../../../src/domain/types.ts";
import type {
  Address as AddressType,
  Bytecode as BytecodeType,
  Selector as SelectorType,
} from "../../../src/domain/types.ts";

// unwrap a Result in tests only; the domain itself never throws.
function mustOk<T, E extends { message: string }>(r: Result<T, E>): T {
  if (!r.ok) {
    throw new Error(`expected ok, got error: ${r.error.message}`);
  }
  return r.value;
}

function mustErr<T, E extends { message: string }>(r: Result<T, E>): E {
  if (r.ok) {
    throw new Error("expected error, got ok");
  }
  return r.error;
}

// Even-length lowercase hex bodies for property tests.
function hexBody(minLength: number, maxLength: number): fc.Arbitrary<string> {
  return fc.array(fc.integer({ min: 0, max: 15 }), { minLength, maxLength }).map((ns) =>
    ns.map((n) => n.toString(16)).join(""),
  );
}

describe("k106_invalid_states_fail_construction_or_compilation", () => {
  test("address: checksummed form stored, both sides of each boundary", () => {
    // EIP-55 reference vector, all-lowercase input is accepted and stored checksummed.
    const lower = "0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed";
    const parsed = mustOk(Address.parse(lower));
    expect(parsed).toBe("0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed");
    // Already-checksummed input round-trips unchanged.
    expect(mustOk(Address.parse(parsed))).toBe(parsed);
    // Zero address is a valid address.
    expect(mustOk(Address.parse("0x0000000000000000000000000000000000000000"))).toBe(
      "0x0000000000000000000000000000000000000000",
    );
    // Boundary failures: 39 and 41 hex chars, missing prefix, non-hex, empty.
    expect(Address.parse("0x5aaeb6053f3e94c9b9a09f33669435e7ef1beae").ok).toBe(false);
    expect(Address.parse("0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed0").ok).toBe(false);
    expect(Address.parse("5aaeb6053f3e94c9b9a09f33669435e7ef1beed").ok).toBe(false);
    expect(Address.parse("0xZZaeb6053f3e94c9b9a09f33669435e7ef1beed").ok).toBe(false);
    expect(Address.parse("").ok).toBe(false);
    expect(Address.parse("0x").ok).toBe(false);
    const errValue = mustErr(Address.parse("0x123"));
    expect(errValue.kind).toBe("invalid-address");
  });

  test("bytecode: even hex length with an explicit size limit", () => {
    expect(mustOk(Bytecode.parse("0x6001")).length).toBe(2);
    expect(mustOk(Bytecode.parse("0x")).length).toBe(0);
    expect(mustOk(Bytecode.parse("6001")).length).toBe(2);
    expect(Bytecode.parse("0x123").ok).toBe(false);
    expect(Bytecode.parse("0xzz").ok).toBe(false);
    expect(Bytecode.parse("").ok).toBe(false);
    // Size limit boundary: 2 bytes pass with limit 2, 3 bytes fail.
    expect(Bytecode.parse("0x6001", 2).ok).toBe(true);
    expect(Bytecode.parse("0x600160", 2).ok).toBe(false);
    expect(mustErr(Bytecode.parse("0x600160", 2)).kind).toBe("invalid-bytecode");
  });

  test("code hash: keccak256 of the full runtime bytecode", () => {
    // Well-known keccak256 vector for empty input.
    const empty = mustOk(CodeHash.of(mustOk(Bytecode.parse("0x"))));
    expect(empty).toBe("0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470");
    // Deterministic: the same bytecode gives the same hash twice.
    const code = mustOk(Bytecode.parse("0x6001600055"));
    expect(mustOk(CodeHash.of(code))).toBe(mustOk(CodeHash.of(code)));
    // Multi-block oracle vector: 200 bytes of 0xab cross the 136-byte rate.
    const longCode = mustOk(Bytecode.parse(`0x${"ab".repeat(200)}`));
    expect(mustOk(CodeHash.of(longCode))).toBe(
      "0x8ca353cee0a5c5b999a0916e88da37a16293cf14a73c735d6b5197b50c3d6656",
    );
  });

  test("skeleton hash: PUSH operands masked, CBOR masked", () => {
    // Same opcode skeleton with different PUSH operands hashes equally.
    const a = mustOk(Bytecode.parse("0x6001600055"));
    const b = mustOk(Bytecode.parse("0x6002600055"));
    expect(mustOk(SkeletonHash.of(a))).toBe(mustOk(SkeletonHash.of(b)));
    // A different opcode skeleton hashes differently.
    const c = mustOk(Bytecode.parse("0x6001600056"));
    expect(mustOk(SkeletonHash.of(a))).not.toBe(mustOk(SkeletonHash.of(c)));
  });

  test("selector: exactly 4 bytes hex", () => {
    expect(mustOk(Selector.parse("0xa9059cbb"))).toBe("0xa9059cbb");
    expect(Selector.parse("a9059cbb").ok).toBe(false);
    expect(Selector.parse("0xa9059cb").ok).toBe(false);
    expect(Selector.parse("0xa9059cbbb").ok).toBe(false);
    expect(Selector.parse("0xZZ059cbb").ok).toBe(false);
    expect(Selector.parse("").ok).toBe(false);
    expect(mustErr(Selector.parse("0x123")).kind).toBe("invalid-selector");
  });

  test("pc offset: integer inside the bytecode", () => {
    const code = mustOk(Bytecode.parse("0x6001600201"));
    expect(mustOk(PcOffset.of(0, code))).toBe(0);
    expect(mustOk(PcOffset.of(4, code))).toBe(4);
    expect(PcOffset.of(5, code).ok).toBe(false);
    expect(PcOffset.of(-1, code).ok).toBe(false);
    expect(PcOffset.of(1.5, code).ok).toBe(false);
    expect(PcOffset.of(Number.NaN, code).ok).toBe(false);
    expect(mustErr(PcOffset.of(99, code)).kind).toBe("invalid-pc-offset");
  });

  test("slot and storage word: exactly 32 bytes hex", () => {
    const word = `0x${"ab".repeat(32)}`;
    expect(mustOk(Slot.parse(word))).toBe(word.toLowerCase());
    expect(mustOk(StorageWord.parse(word))).toBe(word.toLowerCase());
    expect(Slot.parse(`0x${"ab".repeat(31)}`).ok).toBe(false);
    expect(Slot.parse(`0x${"ab".repeat(33)}`).ok).toBe(false);
    expect(Slot.parse("ab".repeat(32)).ok).toBe(false);
    expect(StorageWord.parse(`0x${"zz".repeat(32)}`).ok).toBe(false);
    expect(mustErr(Slot.parse("0x123")).kind).toBe("invalid-slot");
    expect(mustErr(StorageWord.parse("0x123")).kind).toBe("invalid-storage-word");
  });

  test("call data: even hex length", () => {
    expect(mustOk(CallData.parse("0x")).length).toBe(0);
    expect(mustOk(CallData.parse("0xa9059cbb")).length).toBe(4);
    expect(CallData.parse("0x123").ok).toBe(false);
    expect(CallData.parse("0xzz").ok).toBe(false);
    expect(mustErr(CallData.parse("0x1")).kind).toBe("invalid-call-data");
  });

  test("probability: closed unit interval with fixed rounding", () => {
    expect(mustOk(Probability.of(0))).toBe(0);
    expect(mustOk(Probability.of(1))).toBe(1);
    expect(mustOk(Probability.of(0.5))).toBe(0.5);
    expect(Probability.of(-0.000001).ok).toBe(false);
    expect(Probability.of(1.000001).ok).toBe(false);
    expect(Probability.of(Number.NaN).ok).toBe(false);
    expect(Probability.of(Number.POSITIVE_INFINITY).ok).toBe(false);
    expect(Probability.of(Number.NEGATIVE_INFINITY).ok).toBe(false);
    expect(mustErr(Probability.of(2)).kind).toBe("invalid-probability");
    // Fixed rounding to six decimals before storage.
    expect(mustOk(Probability.ofRounded(0.123456789))).toBe(0.123457);
    expect(mustOk(Probability.ofRounded(0.123456789))).toBe(
      mustOk(Probability.of(0.123457)),
    );
    expect(Probability.ofRounded(2).ok).toBe(false);
    expect(Probability.ofRounded(Number.NaN).ok).toBe(false);
  });

  test("risk score: integer in [0, 100]", () => {
    expect(mustOk(RiskScore.of(0))).toBe(0);
    expect(mustOk(RiskScore.of(100))).toBe(100);
    expect(mustOk(RiskScore.of(84))).toBe(84);
    expect(RiskScore.of(-1).ok).toBe(false);
    expect(RiskScore.of(101).ok).toBe(false);
    expect(RiskScore.of(50.5).ok).toBe(false);
    expect(RiskScore.of(Number.NaN).ok).toBe(false);
    expect(mustErr(RiskScore.of(101)).kind).toBe("invalid-risk-score");
  });

  test("chain id, block number, timestamp: bounded integers", () => {
    expect(mustOk(ChainId.of(1))).toBe(1);
    expect(ChainId.of(0).ok).toBe(false);
    expect(ChainId.of(-1).ok).toBe(false);
    expect(ChainId.of(1.5).ok).toBe(false);
    expect(mustErr(ChainId.of(0)).kind).toBe("invalid-chain-id");
    expect(mustOk(BlockNumber.of(0))).toBe(0);
    expect(mustOk(BlockNumber.of(24208800))).toBe(24208800);
    expect(BlockNumber.of(-1).ok).toBe(false);
    expect(BlockNumber.of(1.5).ok).toBe(false);
    expect(mustErr(BlockNumber.of(-1)).kind).toBe("invalid-block-number");
    expect(mustOk(Timestamp.of(0))).toBe(0);
    expect(mustOk(Timestamp.of(1761446400000))).toBe(1761446400000);
    expect(Timestamp.of(-1).ok).toBe(false);
    expect(Timestamp.of(1.5).ok).toBe(false);
    expect(mustErr(Timestamp.of(-1)).kind).toBe("invalid-timestamp");
  });

  test("semver family: strict MAJOR.MINOR.PATCH", () => {
    expect(mustOk(ModelVersion.parse("1.2.3"))).toBe("1.2.3");
    expect(mustOk(IndexVersion.parse("0.0.1"))).toBe("0.0.1");
    expect(mustOk(TemplateVersion.parse("2.0.0-alpha.1"))).toBe("2.0.0-alpha.1");
    expect(mustOk(PromptVersion.parse("1.0.0+build.7"))).toBe("1.0.0+build.7");
    expect(mustOk(ExplanationSchemaVersion.parse("10.20.30"))).toBe("10.20.30");
    for (const raw of ["1.2", "v1.2.3", "1.02.3", "", "1.2.3.4", "latest", "1.2.x"]) {
      expect(ModelVersion.parse(raw).ok, raw).toBe(false);
    }
    expect(mustErr(ModelVersion.parse("1.2")).kind).toBe("invalid-model-version");
    expect(mustErr(IndexVersion.parse("1.2")).kind).toBe("invalid-index-version");
    expect(mustErr(TemplateVersion.parse("1.2")).kind).toBe("invalid-template-version");
    expect(mustErr(PromptVersion.parse("1.2")).kind).toBe("invalid-prompt-version");
    expect(mustErr(ExplanationSchemaVersion.parse("1.2")).kind).toBe(
      "invalid-explanation-schema-version",
    );
  });

  test("model id, clone group id: provider identifiers", () => {
    expect(mustOk(ModelId.parse("meta-models/muse-spark-open-1026"))).toBe(
      "meta-models/muse-spark-open-1026",
    );
    expect(ModelId.parse("").ok).toBe(false);
    expect(ModelId.parse("has space").ok).toBe(false);
    expect(ModelId.parse("x".repeat(257)).ok).toBe(false);
    expect(mustErr(ModelId.parse("")).kind).toBe("invalid-model-id");
    expect(mustOk(CloneGroupId.parse("group-1"))).toBe("group-1");
    expect(CloneGroupId.parse("").ok).toBe(false);
    expect(mustErr(CloneGroupId.parse("")).kind).toBe("invalid-clone-group-id");
  });

  test("artifact checksum: SHA-256 in hex, 64 characters", () => {
    const hex = "9f".repeat(32);
    expect(mustOk(ArtifactChecksum.parse(hex))).toBe(hex);
    expect(mustOk(ArtifactChecksum.parse("9F".repeat(32)))).toBe("9F".repeat(32));
    expect(ArtifactChecksum.parse("9f".repeat(31)).ok).toBe(false);
    expect(ArtifactChecksum.parse("9f".repeat(33)).ok).toBe(false);
    expect(ArtifactChecksum.parse(`0x${"9f".repeat(32)}`).ok).toBe(false);
    expect(ArtifactChecksum.parse("zz".repeat(32)).ok).toBe(false);
    expect(mustErr(ArtifactChecksum.parse("123")).kind).toBe("invalid-artifact-checksum");
  });

  test("request id: UUID form, generated at the boundary", () => {
    expect(mustOk(RequestId.parse("123e4567-e89b-12d3-a456-426614174000"))).toBe(
      "123e4567-e89b-12d3-a456-426614174000",
    );
    expect(RequestId.parse("not-a-uuid").ok).toBe(false);
    expect(RequestId.parse("").ok).toBe(false);
    expect(RequestId.parse("123e4567-e89b-12d3-a456-42661417400").ok).toBe(false);
    expect(mustErr(RequestId.parse("xyz")).kind).toBe("invalid-request-id");
    const generated = mustOk(RequestId.generate(mustOk(Timestamp.of(1761446400000))));
    expect(generated).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    // A generated id parses as a valid id and is stable for the same input.
    expect(mustOk(RequestId.parse(generated))).toBe(generated);
    expect(mustOk(RequestId.generate(mustOk(Timestamp.of(1))))).not.toBe(
      mustOk(RequestId.generate(mustOk(Timestamp.of(2)))),
    );
  });

  test("evidence id and signal id: stably derived, offset-aware", () => {
    const codeHash = mustOk(CodeHash.of(mustOk(Bytecode.parse("0x6001600055"))));
    const selector = mustOk(Selector.parse("0xa9059cbb"));
    const offset = mustOk(PcOffset.of(0, mustOk(Bytecode.parse("0x6001600055"))));
    const withOffset = mustOk(EvidenceId.of(codeHash, selector, offset));
    const withoutOffset = mustOk(EvidenceId.of(codeHash, selector));
    // Same inputs give the same id; the offset participates in the derivation.
    expect(mustOk(EvidenceId.of(codeHash, selector, offset))).toBe(withOffset);
    expect(withOffset).not.toBe(withoutOffset);
    const otherSelector = mustOk(Selector.parse("0x70a08231"));
    expect(mustOk(EvidenceId.of(codeHash, otherSelector))).not.toBe(withoutOffset);
    const signal = mustOk(SignalId.of(codeHash, selector));
    expect(mustOk(SignalId.of(codeHash, selector))).toBe(signal);
    expect(mustOk(SignalId.of(codeHash, otherSelector))).not.toBe(signal);
  });

  test("untrusted text: capped length, content preserved", () => {
    expect(mustOk(UntrustedText.quote("hello"))).toBe("hello");
    expect(mustOk(UntrustedText.quote(""))).toBe("");
    expect(UntrustedText.quote("abc", 3).ok).toBe(true);
    expect(UntrustedText.quote("abcd", 3).ok).toBe(false);
    expect(mustErr(UntrustedText.quote("abcd", 3)).kind).toBe("invalid-untrusted-text");
  });

  test("cache key: composed of code hash and model version", () => {
    const codeHash = mustOk(CodeHash.of(mustOk(Bytecode.parse("0x6001"))));
    const v1 = mustOk(ModelVersion.parse("1.0.0"));
    const v2 = mustOk(ModelVersion.parse("2.0.0"));
    const key = mustOk(CacheKey.of(codeHash, v1));
    expect(key).toContain(codeHash as string);
    expect(key).toContain("1.0.0");
    // A new model version gives a new key; the same pair is stable.
    expect(mustOk(CacheKey.of(codeHash, v2))).not.toBe(key);
    expect(mustOk(CacheKey.of(codeHash, v1))).toBe(key);
  });

  test("page size: positive integer within the page-size limit", () => {
    expect(mustOk(PageSize.of(1))).toBe(1);
    expect(mustOk(PageSize.of(100))).toBe(100);
    expect(PageSize.of(0).ok).toBe(false);
    expect(PageSize.of(101).ok).toBe(false);
    expect(PageSize.of(1.5).ok).toBe(false);
    expect(PageSize.of(Number.NaN).ok).toBe(false);
    expect(mustOk(PageSize.of(5, 10))).toBe(5);
    expect(PageSize.of(11, 10).ok).toBe(false);
    expect(mustErr(PageSize.of(0)).kind).toBe("invalid-page-size");
  });
});

describe("k106 branded type properties", () => {
  test("k106_property_addresses_checksum_and_roundtrip", () => {
    fc.assert(
      fc.property(hexBody(40, 40), (hex) => {
        const addr = mustOk(Address.parse(`0x${hex}`));
        // Stored form matches 0x plus 40 hex characters and re-parses unchanged.
        expect(addr).toMatch(/^0x[0-9a-fA-F]{40}$/);
        expect(mustOk(Address.parse(addr))).toBe(addr);
      }),
      { seed: 106002, numRuns: 100 },
    );
  });

  test("k106_property_probability_unit_interval_roundtrip", () => {
    fc.assert(
      fc.property(fc.double({ min: 0, max: 1, noNaN: true }), (value) => {
        const rounded = mustOk(Probability.ofRounded(value));
        expect(rounded).toBeGreaterThanOrEqual(0);
        expect(rounded).toBeLessThanOrEqual(1);
        expect(mustOk(Probability.of(rounded))).toBe(rounded);
      }),
      { seed: 106003, numRuns: 200 },
    );
  });

  test("k106_property_out_of_range_probabilities_fail", () => {
    fc.assert(
      fc.property(
        fc.double({ min: 1.000001, max: 1000, noNaN: true }).filter((v) => Number.isFinite(v)),
        (value) => {
          expect(Probability.of(value).ok).toBe(false);
        },
      ),
      { seed: 106004, numRuns: 100 },
    );
  });

  test("k106_property_bytecode_length_matches_hex", () => {
    fc.assert(
      fc.property(hexBody(0, 200), (hex) => {
        const even = hex.length % 2 === 0 ? hex : hex.slice(0, -1);
        const code = mustOk(Bytecode.parse(`0x${even}`));
        expect(code.length).toBe(even.length / 2);
      }),
      { seed: 106005, numRuns: 100 },
    );
  });

  test("k106_property_skeleton_masks_push_operands", () => {
    // PUSH1 X PUSH1 00 SSTORE with any operand byte shares one skeleton hash.
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 255 }), fc.integer({ min: 0, max: 255 }), (x, y) => {
        const toHex = (n: number): string => n.toString(16).padStart(2, "0");
        const left = mustOk(Bytecode.parse(`0x60${toHex(x)}600055`));
        const right = mustOk(Bytecode.parse(`0x60${toHex(y)}600055`));
        expect(mustOk(SkeletonHash.of(left))).toBe(mustOk(SkeletonHash.of(right)));
      }),
      { seed: 106006, numRuns: 100 },
    );
  });

  test("k106_property_code_hash_deterministic", () => {
    fc.assert(
      fc.property(hexBody(0, 200), (hex) => {
        const even = hex.length % 2 === 0 ? hex : hex.slice(0, -1);
        const code = mustOk(Bytecode.parse(`0x${even}`));
        expect(mustOk(CodeHash.of(code))).toBe(mustOk(CodeHash.of(code)));
      }),
      { seed: 106007, numRuns: 100 },
    );
  });
});

describe("k106 compile-time branding", () => {
  test("k106_branded_types_reject_raw_primitives_at_compile_time", () => {
    function requireAddress(value: AddressType): AddressType {
      return value;
    }
    function requireSelector(value: SelectorType): SelectorType {
      return value;
    }
    const addr = mustOk(Address.parse("0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed"));
    const selector = mustOk(Selector.parse("0xa9059cbb"));
    expect(requireAddress(addr)).toBe(addr);
    expect(requireSelector(selector)).toBe(selector);
    expectTypeOf(addr).toEqualTypeOf<AddressType>();
    expectTypeOf(selector).toEqualTypeOf<SelectorType>();
    expectTypeOf<AddressType>().not.toEqualTypeOf<SelectorType>();
    // @ts-expect-error: a raw string is not an Address.
    requireAddress("0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed");
    // @ts-expect-error: a Selector is not an Address.
    requireAddress(selector);
    const rawBytes = new Uint8Array([0x60, 0x01]);
    // @ts-expect-error: raw bytes are not Bytecode.
    const asBytecode: BytecodeType = rawBytes;
    expect(asBytecode.length).toBe(2);
  });
});
