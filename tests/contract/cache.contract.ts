// Shared contract suite for CachePort (A-22, K-013, K-511).
// Runs the same suite against the fake in tests/fakes and the in-memory
// adapter in src/adapters/cache, so the fake stays honest against the port
// contract: a hit returns the stored entry unchanged, a miss returns null,
// and every corrupt or impersonating entry yields the typed entry-corrupt
// branch. Corrupt bytes reach the adapter through the seed map, the same
// path a restored snapshot or a poisoning drill would take.
import { describe, expect, test } from "vitest";
import { standardCantTell } from "../../src/domain/cantTell.ts";
import { Evidence } from "../../src/domain/evidence.ts";
import { SUPPORTED_TEMPLATE_VERSION, renderExplanation } from "../../src/domain/explain.ts";
import { noneProxyResolution } from "../../src/domain/proxy.ts";
import type { Result } from "../../src/domain/result.ts";
import { Signal } from "../../src/domain/signals.ts";
import {
  Address,
  ArtifactChecksum,
  BlockNumber,
  Bytecode,
  CacheKey,
  CodeHash,
  IndexVersion,
  ModelVersion,
  Probability,
  RiskScore,
  Selector,
  Timestamp,
} from "../../src/domain/types.ts";
import type {
  CacheKey as CacheKeyType,
  CodeHash as CodeHashType,
  ModelVersion as ModelVersionType,
} from "../../src/domain/types.ts";
import type { CachePort, CachedAssessment } from "../../src/ports/cache.ts";

function mustOk<T, E extends { message: string }>(result: Result<T, E>): T {
  if (!result.ok) {
    throw new Error(`expected ok, got error: ${result.error.message}`);
  }
  return result.value;
}

const TARGET = "0x0102030405060708090a0b0c0d0e0f1011121314";
const DISPATCHER_BYTECODE = "0x8063a9059cbb1461005b57ff";

// One valid stored entry built through the domain constructors, so the
// suite checks the same shape the application service stores after a
// real analysis. The score override keeps same-key overwrites observable.
export function makeContractEntry(
  codeHash: CodeHashType,
  modelVersion: ModelVersionType,
  score = 50,
): CachedAssessment {
  const target = mustOk(Address.parse(TARGET));
  const block = mustOk(BlockNumber.of(24000000));
  const selector = mustOk(Selector.parse("0xa9059cbb"));
  const evidence = mustOk(Evidence.create({ selector }));
  const temporality = { kind: "can-change", changer: target } as const;
  const signal = mustOk(
    Signal.createCapability({
      codeHash,
      risk: "rug-pull",
      direction: "raises",
      severity: "high",
      temporality,
      evidence: [evidence],
    }),
  );
  const templateVersion = SUPPORTED_TEMPLATE_VERSION;
  const explanation = mustOk(renderExplanation({ signals: [signal], templateVersion, observed: temporality }));
  return Object.freeze({
    kind: "assessed",
    target,
    block,
    proxy: noneProxyResolution(),
    codeHash,
    modelVersion,
    artifactChecksum: mustOk(ArtifactChecksum.parse("ab".repeat(32))),
    indexVersion: mustOk(IndexVersion.parse("1.0.0")),
    templateVersion,
    assessedAt: mustOk(Timestamp.of(1700000000000)),
    probabilities: Object.freeze({
      "rug-pull": mustOk(Probability.ofRounded(0.5)),
      honeypot: mustOk(Probability.ofRounded(0.5)),
      "bot-pump": mustOk(Probability.ofRounded(0.5)),
    }),
    score: mustOk(RiskScore.of(score)),
    signals: Object.freeze([signal]),
    pluginResults: Object.freeze([]),
    explanation,
    cantTell: standardCantTell(),
  });
}

export function contractKey(
  codeHash: CodeHashType,
  modelVersion: ModelVersionType,
): CacheKeyType {
  const key = CacheKey.of(codeHash, modelVersion);
  if (!key.ok) {
    throw new Error(`expected a cache key: ${key.error.message}`);
  }
  return key.value;
}

function fixedCodeHash(): CodeHashType {
  const code = mustOk(Bytecode.parse(DISPATCHER_BYTECODE));
  return mustOk(CodeHash.of(code));
}

function fixedModelVersion(): ModelVersionType {
  return mustOk(ModelVersion.parse("0.1.0"));
}

const CORRUPT_CASES: ReadonlyArray<readonly [string, unknown]> = [
  ["plain text", "not a stored entry"],
  ["null", null],
  ["number", 42],
  ["array", [1, 2, 3]],
  ["empty object", {}],
  ["truncated entry", { kind: "assessed" }],
  ["wrong kind", { kind: "no-contract" }],
  ["entry with corrupt signals", { kind: "assessed", signals: "oops" }],
];

export function runCachePortContract(
  label: string,
  makePort: (seed?: ReadonlyMap<CacheKeyType, unknown> | undefined) => CachePort,
  options: { makeUnavailable?: (() => CachePort) | undefined } = {},
): void {
  describe(`CachePort contract: ${label}`, () => {
    test("put then get returns the stored entry and leaves the inputs unchanged", async () => {
      const port = makePort();
      const codeHash = fixedCodeHash();
      const modelVersion = fixedModelVersion();
      const key = contractKey(codeHash, modelVersion);
      const entry = makeContractEntry(codeHash, modelVersion);
      const before = JSON.stringify({ key: key as string, entry });
      const stored = await port.put(key, entry);
      expect(stored.ok).toBe(true);
      const loaded = await port.get(key);
      expect(loaded.ok).toBe(true);
      if (!loaded.ok) {
        return;
      }
      expect(loaded.value).toEqual(entry);
      expect(JSON.stringify({ key: key as string, entry })).toBe(before);
    });

    test("get on an unknown key returns a null miss", async () => {
      const port = makePort();
      const key = contractKey(fixedCodeHash(), mustOk(ModelVersion.parse("9.9.9")));
      const loaded = await port.get(key);
      expect(loaded.ok).toBe(true);
      if (!loaded.ok) {
        return;
      }
      expect(loaded.value).toBeNull();
    });

    test("put overwrites the previous entry under the same key", async () => {
      const port = makePort();
      const codeHash = fixedCodeHash();
      const modelVersion = fixedModelVersion();
      const key = contractKey(codeHash, modelVersion);
      const first = await port.put(key, makeContractEntry(codeHash, modelVersion, 10));
      expect(first.ok).toBe(true);
      const second = await port.put(key, makeContractEntry(codeHash, modelVersion, 90));
      expect(second.ok).toBe(true);
      const loaded = await port.get(key);
      expect(loaded.ok).toBe(true);
      if (!loaded.ok || loaded.value === null) {
        throw new Error("expected the overwritten entry");
      }
      expect(loaded.value.score as number).toBe(90);
    });

    for (const [name, raw] of CORRUPT_CASES) {
      test(`corrupt seeded bytes (${name}) yield typed entry-corrupt`, async () => {
        const codeHash = fixedCodeHash();
        const modelVersion = fixedModelVersion();
        const key = contractKey(codeHash, modelVersion);
        const port = makePort(new Map([[key, raw]]));
        const before = key as string;
        const loaded = await port.get(key);
        expect(loaded.ok).toBe(false);
        if (loaded.ok) {
          return;
        }
        expect(loaded.error.kind).toBe("entry-corrupt");
        expect(loaded.error.message.length).toBeGreaterThan(0);
        expect(key as string).toBe(before);
      });
    }

    test("entry stored under another key is rejected as entry-corrupt", async () => {
      const codeHash = fixedCodeHash();
      const storedVersion = fixedModelVersion();
      const requestedVersion = mustOk(ModelVersion.parse("0.2.0"));
      const requestedKey = contractKey(codeHash, requestedVersion);
      const foreign = makeContractEntry(codeHash, storedVersion);
      const port = makePort(new Map([[requestedKey, foreign]]));
      const loaded = await port.get(requestedKey);
      expect(loaded.ok).toBe(false);
      if (loaded.ok) {
        return;
      }
      expect(loaded.error.kind).toBe("entry-corrupt");
    });

    test("put rejects an entry whose key points at another version", async () => {
      const port = makePort();
      const codeHash = fixedCodeHash();
      const stored = await port.put(
        contractKey(codeHash, fixedModelVersion()),
        makeContractEntry(codeHash, mustOk(ModelVersion.parse("0.2.0"))),
      );
      expect(stored.ok).toBe(false);
      if (stored.ok) {
        return;
      }
      expect(stored.error.kind).toBe("entry-corrupt");
    });

    if (options.makeUnavailable !== undefined) {
      const makeDown = options.makeUnavailable;
      test("unavailable store yields typed store-unavailable on get and put", async () => {
        const port = makeDown();
        const codeHash = fixedCodeHash();
        const modelVersion = fixedModelVersion();
        const key = contractKey(codeHash, modelVersion);
        const loaded = await port.get(key);
        expect(loaded.ok).toBe(false);
        if (!loaded.ok) {
          expect(loaded.error.kind).toBe("store-unavailable");
        }
        const stored = await port.put(key, makeContractEntry(codeHash, modelVersion));
        expect(stored.ok).toBe(false);
        if (!stored.ok) {
          expect(stored.error.kind).toBe("store-unavailable");
        }
      });
    }
  });
}
