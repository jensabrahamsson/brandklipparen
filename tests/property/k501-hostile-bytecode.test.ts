// Hostile bytecode fuzz: mutated fixtures yield a signal or a typed error,
// never a process crash (K-501, M-02). Written first per A-21 (red): the
// property below fails while any analysis step throws on distorted input.
// Fakes and frozen fixtures only; no network, no secrets.
import { describe, expect, test } from "vitest";
import * as fc from "fast-check";
import { analyzeToken } from "../../src/application/analyzeToken.ts";
import type { AnalyzeTokenInput } from "../../src/application/analyzeToken.ts";
import { detectCapabilities } from "../../src/domain/signals.ts";
import type { CapabilityCatalogue } from "../../src/domain/signals.ts";
import { extractSelectors } from "../../src/domain/selectors.ts";
import { SkeletonHash } from "../../src/domain/types.ts";
import {
  Address,
  ArtifactChecksum,
  BlockNumber,
  Bytecode,
  CodeHash,
  IndexVersion,
  ModelVersion,
  RequestId,
  TemplateVersion,
  Timestamp,
} from "../../src/domain/types.ts";
import type { Result } from "../../src/domain/result.ts";
import { parseModelArtifact } from "../../src/domain/risk.ts";
import { FakeClockAdapter } from "../fakes/fakeClock.ts";
import { FakeDecompilerAdapter } from "../fakes/fakeDecompiler.ts";
import { FakeModelArtifactAdapter } from "../fakes/fakeModelArtifact.ts";
import { FakeRpcAdapter } from "../fakes/fakeRpc.ts";

function mustOk<T, E extends { message: string }>(result: Result<T, E>): T {
  if (!result.ok) {
    throw new Error(`expected ok, got error: ${result.error.message}`);
  }
  return result.value;
}

function placeholderArtifact(): FakeModelArtifactAdapter {
  const artifact = mustOk(
    parseModelArtifact({
      version: "0.1.0",
      severityWeights: { low: 0.2, medium: 0.5, high: 1.0 },
      causeWeights: {
        timeout: 0.4,
        "resource-limit": 0.4,
        "decompiler-error": 0.6,
        "obfuscated-structure": 0.6,
      },
      biases: { "rug-pull": 0.0, honeypot: 0.0, "bot-pump": 0.0 },
      calibration: {
        "rug-pull": { slope: 1.0, intercept: 0.0 },
        honeypot: { slope: 1.0, intercept: 0.0 },
        "bot-pump": { slope: 1.0, intercept: 0.0 },
      },
      scoreWeights: { "rug-pull": 1.0, honeypot: 1.0, "bot-pump": 1.0 },
    }),
  );
  return new FakeModelArtifactAdapter(
    Object.freeze({
      artifact,
      checksum: mustOk(ArtifactChecksum.parse("cd".repeat(32))),
    }),
  );
}

// Placeholder catalogue for the test only: fixed risk mapping per
// capability key, so detection yields signals without learned values.
const TEST_CATALOGUE: CapabilityCatalogue = Object.freeze({
  selfdestruct: Object.freeze({ risk: "rug-pull", direction: "raises", severity: "high" }),
  delegatecall: Object.freeze({ risk: "rug-pull", direction: "raises", severity: "high" }),
  call: Object.freeze({ risk: "honeypot", direction: "raises", severity: "medium" }),
  "storage-write": Object.freeze({ risk: "bot-pump", direction: "raises", severity: "low" }),
});

// A real dispatcher-shaped fixture that the arbitraries mutate byte by
// byte, plus fully random bytes for the degenerate end of the input space.
const SEED_BYTECODE = `0x8063a9059cbb14600a57806370a0823114600f575b6000355bff`;

function toHex(bytes: readonly number[]): string {
  return `0x${bytes.map((byte) => (byte as number).toString(16).padStart(2, "0")).join("")}`;
}

const MUTATED_SEED_ARB = fc
  .tuple(
    fc.array(fc.integer({ min: 0, max: 255 }), { minLength: 0, maxLength: 64 }),
    fc.array(fc.integer({ min: 0, max: 7 }), { minLength: 0, maxLength: 6 }),
  )
  .map(([extra, flips]) => {
    const seed = SEED_BYTECODE.slice(2);
    const bytes: number[] = [];
    for (let i = 0; i < seed.length; i += 2) {
      bytes.push(parseInt(seed.slice(i, i + 2), 16));
    }
    for (const flip of flips as readonly number[]) {
      if (bytes.length > 0) {
        const at = (flip as number) % bytes.length;
        bytes[at] = ((bytes[at] ?? 0) + 0x63 + (flip as number)) % 256;
      }
    }
    return toHex([...bytes, ...(extra as readonly number[])]);
  });

const MUTATED_BYTECODE_ARB = fc.oneof(
  MUTATED_SEED_ARB,
  fc.array(fc.integer({ min: 0, max: 255 }), { minLength: 0, maxLength: 96 }).map(toHex),
  fc.string({ maxLength: 48 }),
);

function baseInput(bytecodeHex: string): { input: AnalyzeTokenInput; codes: Map<string, string> } {
  const address = mustOk(Address.parse("0x0102030405060708090a0b0c0d0e0f1011121314"));
  const block = mustOk(BlockNumber.of(18000000));
  const codes = new Map<string, string>([[address as string, bytecodeHex]]);
  const input: AnalyzeTokenInput = {
    address,
    block,
    requestId: mustOk(RequestId.parse("123e4567-e89b-42d3-a456-426614174000")),
    deadline: mustOk(Timestamp.of(1900000000000)),
    modelVersion: mustOk(ModelVersion.parse("0.1.0")),
    indexVersion: mustOk(IndexVersion.parse("1.0.0")),
    templateVersion: mustOk(TemplateVersion.parse("1.0.0")),
    catalogue: TEST_CATALOGUE,
  };
  return { input, codes };
}

describe("hostile bytecode stays inside typed outcomes (K-501, M-02)", () => {
  test("k501_mutated_bytecode_yields_signal_or_typed_error", async () => {
    await fc.assert(
      fc.asyncProperty(MUTATED_BYTECODE_ARB, async (raw) => {
        // Pure screening steps: distorted input ends in a typed parse
        // error or a completed screening, never an exception.
        const parsed = Bytecode.parse(raw);
        if (!parsed.ok) {
          expect(parsed.error.kind).toBe("invalid-bytecode");
        } else {
          const codeHash = mustOk(CodeHash.of(parsed.value));
          const observed = {
            kind: "can-change",
            changer: mustOk(Address.parse("0x0102030405060708090a0b0c0d0e0f1011121314")),
          } as const;
          const signals = detectCapabilities(parsed.value, codeHash, TEST_CATALOGUE, observed);
          expect(Array.isArray(signals)).toBe(true);
          // The remaining pure steps total over the same bytes as well.
          extractSelectors(parsed.value);
          mustOk(SkeletonHash.of(parsed.value));
        }
        // Full service path with fakes: every mutated fixture resolves to
        // an assessed outcome or a typed application error, so the process
        // survives every run by construction of the awaits below.
        const { input, codes } = baseInput(raw);
        const outcome = await analyzeToken(
          {
            rpc: new FakeRpcAdapter(codes, mustOk(BlockNumber.of(18000000))),
            modelArtifacts: placeholderArtifact(),
            clock: new FakeClockAdapter(mustOk(Timestamp.of(1700000000000))),
            decompiler: new FakeDecompilerAdapter(),
          },
          input,
        );
        if (outcome.ok) {
          expect(["assessed", "no-contract"]).toContain(outcome.value.kind);
        } else {
          expect(["rpc-error", "model-artifact-error", "domain-error"]).toContain(outcome.error.kind);
        }
      }),
      { numRuns: 100 },
    );
  });
});
