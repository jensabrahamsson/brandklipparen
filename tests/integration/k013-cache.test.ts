// Analysis cache keyed per code hash (S-010, K-013, K-511, I-14).
// A cache hit returns the stored assessment and skips decompilation and all
// external calls; a new model version bypasses older entries; a corrupt
// entry falls back to a fresh analysis.
import { describe, expect, test } from "vitest";
import { InMemoryCacheAdapter } from "../../src/adapters/cache/inMemoryCache.ts";
import {
  createAppServices,
  serializeAssessment,
} from "../../src/application/analyzeToken.ts";
import type { Result } from "../../src/domain/result.ts";
import { parseModelArtifact } from "../../src/domain/risk.ts";
import {
  Address,
  ArtifactChecksum,
  BlockNumber,
  Bytecode,
  CacheKey,
  CodeHash,
  IndexVersion,
  ModelVersion,
  RequestId,
  TemplateVersion,
  Timestamp,
} from "../../src/domain/types.ts";
import type {
  ModelVersion as ModelVersionType,
} from "../../src/domain/types.ts";
import type { CapabilityCatalogue } from "../../src/domain/signals.ts";
import type {
  LoadedArtifact,
  ModelArtifactError,
  ModelArtifactPort,
} from "../../src/ports/modelArtifact.ts";
import { FakeCacheAdapter } from "../fakes/fakeCache.ts";
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

function placeholderLoadedArtifact(version: string): LoadedArtifact {
  const artifact = mustOk(
    parseModelArtifact({
      version,
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
  return Object.freeze({
    artifact,
    checksum: mustOk(ArtifactChecksum.parse("ab".repeat(32))),
  });
}

class DualArtifactAdapter implements ModelArtifactPort {
  loadCalls = 0;

  constructor(
    private readonly first: LoadedArtifact,
    private readonly second: LoadedArtifact,
  ) {}

  load(version: ModelVersionType): Result<LoadedArtifact, ModelArtifactError> {
    this.loadCalls += 1;
    if ((version as string) === (this.first.artifact.version as string)) {
      return { ok: true, value: this.first };
    }
    if ((version as string) === (this.second.artifact.version as string)) {
      return { ok: true, value: this.second };
    }
    return { ok: false, error: { kind: "unknown-version", message: `unknown model version: ${version as string}` } };
  }
}

const TEST_CATALOGUE: CapabilityCatalogue = Object.freeze({
  selfdestruct: Object.freeze({ risk: "rug-pull", direction: "raises", severity: "high" }),
  delegatecall: Object.freeze({ risk: "rug-pull", direction: "raises", severity: "high" }),
  call: Object.freeze({ risk: "honeypot", direction: "raises", severity: "medium" }),
  "storage-write": Object.freeze({ risk: "bot-pump", direction: "raises", severity: "low" }),
});

// Dispatcher window with a paired PUSH4 selector plus SELFDESTRUCT, so the
// miss path stores signals with decompiler snippets beside them.
const TARGET = "0x0102030405060708090a0b0c0d0e0f1011121314";
const BYTECODE_HEX = "0x8063a9059cbb1461005b57ff";

function testInput(modelVersion: ModelVersionType) {
  return {
    address: mustOk(Address.parse(TARGET)),
    block: mustOk(BlockNumber.of(24000000)),
    requestId: mustOk(RequestId.parse("123e4567-e89b-12d3-a456-426614174000")),
    deadline: mustOk(Timestamp.of(1700000005000)),
    modelVersion,
    indexVersion: mustOk(IndexVersion.parse("1.0.0")),
    templateVersion: mustOk(TemplateVersion.parse("1.0.0")),
    catalogue: TEST_CATALOGUE,
  };
}

describe("analysis cache per code hash (K-013)", () => {
  test("k013_cache_hit_skips_decompilation_and_external_calls", async () => {
    const target = mustOk(Address.parse(TARGET));
    const block = mustOk(BlockNumber.of(24000000));
    const rpc = new FakeRpcAdapter(
      new Map([[target as string, BYTECODE_HEX]]),
      block,
    );
    const artifacts = new FakeModelArtifactAdapter(placeholderLoadedArtifact("0.1.0"));
    const clock = new FakeClockAdapter(mustOk(Timestamp.of(1700000000000)));
    const decompiler = new FakeDecompilerAdapter({ scenario: "success" });
    const cache = new InMemoryCacheAdapter();
    const services = createAppServices({ rpc, modelArtifacts: artifacts, clock, decompiler, cache });

    const input = testInput(mustOk(ModelVersion.parse("0.1.0")));
    const first = await services.analyzeToken(input);
    expect(first.ok).toBe(true);
    if (!first.ok || first.value.kind !== "assessed") {
      throw new Error("expected an assessed envelope on the miss path");
    }
    // The miss path does the full work: bytecode fetch, decompilation and
    // one artifact load.
    expect(rpc.getCodeCalls.length).toBeGreaterThan(0);
    expect(decompiler.callCount).toBeGreaterThan(0);
    expect(artifacts.loadCalls).toBeGreaterThan(0);
    const codeCalls = rpc.getCodeCalls.length;
    const storageCalls = rpc.getStorageAtCalls.length;
    const blockCalls = rpc.getBlockNumberCalls;
    const decompilerCalls = decompiler.callCount;
    const artifactCalls = artifacts.loadCalls;

    const second = await services.analyzeToken(input);
    expect(second.ok).toBe(true);
    if (!second.ok || second.value.kind !== "assessed") {
      throw new Error("expected an assessed envelope on the hit path");
    }
    // The hit returns the stored assessment with zero new external calls:
    // no RPC, no decompilation, no artifact load.
    expect(rpc.getCodeCalls.length).toBe(codeCalls);
    expect(rpc.getStorageAtCalls.length).toBe(storageCalls);
    expect(rpc.getBlockNumberCalls).toBe(blockCalls);
    expect(decompiler.callCount).toBe(decompilerCalls);
    expect(artifacts.loadCalls).toBe(artifactCalls);
    expect(serializeAssessment(second.value.envelope)).toBe(
      serializeAssessment(first.value.envelope),
    );
  });

  test("k013_new_model_version_bypasses_old_entries", async () => {
    const target = mustOk(Address.parse(TARGET));
    const block = mustOk(BlockNumber.of(24000000));
    const rpc = new FakeRpcAdapter(new Map([[target as string, BYTECODE_HEX]]), block);
    const artifacts = new DualArtifactAdapter(
      placeholderLoadedArtifact("0.1.0"),
      placeholderLoadedArtifact("0.2.0"),
    );
    const clock = new FakeClockAdapter(mustOk(Timestamp.of(1700000000000)));
    const decompiler = new FakeDecompilerAdapter({ scenario: "success" });
    const cache = new InMemoryCacheAdapter();
    const services = createAppServices({ rpc, modelArtifacts: artifacts, clock, decompiler, cache });

    const oldVersion = mustOk(ModelVersion.parse("0.1.0"));
    const newVersion = mustOk(ModelVersion.parse("0.2.0"));

    const firstOld = await services.analyzeToken(testInput(oldVersion));
    expect(firstOld.ok).toBe(true);
    const codeCallsAfterOld = rpc.getCodeCalls.length;
    expect(codeCallsAfterOld).toBeGreaterThan(0);

    const secondOld = await services.analyzeToken(testInput(oldVersion));
    expect(secondOld.ok).toBe(true);
    expect(rpc.getCodeCalls.length).toBe(codeCallsAfterOld);

    // A new model version misses the old entries and analyses again.
    const firstNew = await services.analyzeToken(testInput(newVersion));
    expect(firstNew.ok).toBe(true);
    if (!firstNew.ok || firstNew.value.kind !== "assessed") {
      throw new Error("expected an assessed envelope for the new model version");
    }
    expect(rpc.getCodeCalls.length).toBeGreaterThan(codeCallsAfterOld);
    expect(firstNew.value.envelope.modelVersion as string).toBe("0.2.0");
    const codeCallsAfterNew = rpc.getCodeCalls.length;

    const secondNew = await services.analyzeToken(testInput(newVersion));
    expect(secondNew.ok).toBe(true);
    expect(rpc.getCodeCalls.length).toBe(codeCallsAfterNew);

    // The old entries stay usable beside the new ones.
    const thirdOld = await services.analyzeToken(testInput(oldVersion));
    expect(thirdOld.ok).toBe(true);
    expect(rpc.getCodeCalls.length).toBe(codeCallsAfterNew);
  });

  test("k013_corrupt_cache_entry_falls_back_to_fresh_analysis", async () => {
    const target = mustOk(Address.parse(TARGET));
    const block = mustOk(BlockNumber.of(24000000));
    const rpc = new FakeRpcAdapter(new Map([[target as string, BYTECODE_HEX]]), block);
    const artifacts = new FakeModelArtifactAdapter(placeholderLoadedArtifact("0.1.0"));
    const clock = new FakeClockAdapter(mustOk(Timestamp.of(1700000000000)));
    const decompiler = new FakeDecompilerAdapter({ scenario: "success" });
    const cache = new FakeCacheAdapter();
    const services = createAppServices({ rpc, modelArtifacts: artifacts, clock, decompiler, cache });

    const modelVersion = mustOk(ModelVersion.parse("0.1.0"));
    const first = await services.analyzeToken(testInput(modelVersion));
    expect(first.ok).toBe(true);
    const codeCalls = rpc.getCodeCalls.length;

    const codeHash = mustOk(CodeHash.of(mustOk(Bytecode.parse(BYTECODE_HEX))));
    const key = mustOk(CacheKey.of(codeHash, modelVersion));
    cache.injectRaw(key, "poisoned entry");

    // A corrupt entry degrades to a fresh analysis instead of an error, and
    // the fresh result is cached again, so the next call hits.
    const second = await services.analyzeToken(testInput(modelVersion));
    expect(second.ok).toBe(true);
    if (!second.ok || second.value.kind !== "assessed") {
      throw new Error("expected an assessed envelope after cache corruption");
    }
    expect(rpc.getCodeCalls.length).toBeGreaterThan(codeCalls);

    const recoveredCalls = rpc.getCodeCalls.length;
    const third = await services.analyzeToken(testInput(modelVersion));
    expect(third.ok).toBe(true);
    expect(rpc.getCodeCalls.length).toBe(recoveredCalls);
  });
});
