// Analysis cache keyed per code hash (S-010, K-013, K-511, I-14).
// A cache hit returns the stored assessment and skips decompilation and all
// external calls; a new model version bypasses older entries; a corrupt
// entry falls back to a fresh analysis.
import { describe, expect, test } from "vitest";
import { InMemoryCacheAdapter } from "../../src/adapters/cache/inMemoryCache.ts";
import { createAppServices } from "../../src/application/analyzeToken.ts";
import { err } from "../../src/domain/result.ts";
import type { Result } from "../../src/domain/result.ts";
import {
  ADD,
  CALLDATALOAD,
  KECCAK,
  SLOAD,
  SSTORE,
  STOP,
  ownerGuard,
  push1,
  sstoreConstSlot,
  tokenBytecode,
} from "../helpers/ownerControlFixtures.ts";
import { syntheticAddress } from "../helpers/syntheticAddresses.ts";
import type { StorageWord as StorageWordType } from "../../src/domain/types.ts";
import type { RpcError } from "../../src/ports/rpc.ts";
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
import type { CapabilityCatalogue, Signal } from "../../src/domain/signals.ts";
import { IMPLEMENTATION_SLOT } from "../../src/domain/proxy.ts";
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
import { mustDefaultDetectorSet } from "../helpers/detectorSets.ts";

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

  private readonly first: LoadedArtifact;
  private readonly second: LoadedArtifact;

  constructor(first: LoadedArtifact, second: LoadedArtifact) {
    this.first = first;
    this.second = second;
  }

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
  test("k013_cache_hit_keeps_requesting_address_and_proxy", async () => {
    // Two proxies share identical runtime bytecode but point at different
    // EIP-1967 implementations. The second analysis must carry its own
    // target and proxy details, never the first address's cached ones.
    const first = mustOk(Address.parse("0x0102030405060708090a0b0c0d0e0f1011121314"));
    const second = mustOk(Address.parse("0x02030405060708090a0b0c0d0e0f101112131415"));
    const implA = mustOk(Address.parse("0x1112131415161718191a1b1c1d1e1f2021222324"));
    const implB = mustOk(Address.parse("0x2122232425262728292a2b2c2d2e2f3031323334"));
    const sharedCode = "0x6001600a600b600c600d600e600f55";
    const implCode = "0x6001600055";
    const wordOf = (raw: string): string => `0x${"0".repeat(24)}${raw.slice(2).toLowerCase()}`;
    const block = mustOk(BlockNumber.of(24000000));
    const codes = new Map<string, string>([
      [first as string, sharedCode],
      [second as string, sharedCode],
      [implA as string, implCode],
      [implB as string, implCode],
    ]);
    const storage = new Map<string, Map<string, string>>([
      [first as string, new Map([[(IMPLEMENTATION_SLOT as string).toLowerCase(), wordOf(implA as string)]])],
      [second as string, new Map([[(IMPLEMENTATION_SLOT as string).toLowerCase(), wordOf(implB as string)]])],
    ]);
    const services = createAppServices({
      rpc: new FakeRpcAdapter(codes, block, storage),
      modelArtifacts: new FakeModelArtifactAdapter(placeholderLoadedArtifact("0.1.0")),
      clock: new FakeClockAdapter(mustOk(Timestamp.of(1700000000000))),
      cache: new InMemoryCacheAdapter(),
    },
    mustDefaultDetectorSet());
    const version = mustOk(ModelVersion.parse("0.1.0"));
    const analysedFirst = await services.analyzeToken({ ...testInput(version), address: first });
    expect(analysedFirst.ok).toBe(true);
    if (!analysedFirst.ok || analysedFirst.value.kind !== "assessed") {
      throw new Error("expected an assessed envelope for the first address");
    }
    expect(analysedFirst.value.envelope.target as string).toBe(first as string);
    const proxyFirst = analysedFirst.value.envelope.proxy;
    expect(proxyFirst.kind).toBe("eip1967");
    if (proxyFirst.kind !== "eip1967") {
      throw new Error("expected an EIP-1967 proxy for the first address");
    }
    expect(proxyFirst.implementation as string).toBe(implA as string);

    const analysedSecond = await services.analyzeToken({ ...testInput(version), address: second });
    expect(analysedSecond.ok).toBe(true);
    if (!analysedSecond.ok || analysedSecond.value.kind !== "assessed") {
      throw new Error("expected an assessed envelope for the second address");
    }
    expect(analysedSecond.value.envelope.target as string).toBe(second as string);
    expect(analysedSecond.value.envelope.block as number).toBe(24000000);
    const proxySecond = analysedSecond.value.envelope.proxy;
    expect(proxySecond.kind).toBe("eip1967");
    if (proxySecond.kind !== "eip1967") {
      throw new Error("expected an EIP-1967 proxy for the second address");
    }
    expect(proxySecond.implementation as string).toBe(implB as string);
    // The cached findings are code-derived, never address state: neither
    // run replays the other address's implementation (C-20, F-21).
    expect(JSON.stringify(analysedSecond.value.envelope.pluginResults)).not.toContain(implA as string);
    expect(JSON.stringify(analysedSecond.value.envelope.pluginResults)).toContain(implB as string);
    expect(JSON.stringify(analysedFirst.value.envelope.pluginResults)).not.toContain(implB as string);
  });

  test("k013_tail_variant_does_not_share_cache_entry", () => {
    // Cache-poisoning shape: two deployments share the executable prefix
    // but carry different trailing blobs shaped like CBOR footers. The
    // cache key must follow the full runtime bytes, so the second
    // deployment never inherits the first deployment's cached score.
    const prefix = "0x8063a9059cbb1461005b57ff";
    const codeA = mustOk(Bytecode.parse(`${prefix}a20102000004`));
    const codeB = mustOk(Bytecode.parse(`${prefix}a20908000004`));
    const version = mustOk(ModelVersion.parse("0.1.0"));
    expect(mustOk(CodeHash.of(codeA))).not.toBe(mustOk(CodeHash.of(codeB)) as string);
    const keyA = mustOk(CacheKey.of(mustOk(CodeHash.of(codeA)), version));
    const keyB = mustOk(CacheKey.of(mustOk(CodeHash.of(codeB)), version));
    expect(keyA).not.toBe(keyB as string);
  });

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
    const services = createAppServices({ rpc, modelArtifacts: artifacts, clock, decompiler, cache },
  mustDefaultDetectorSet());

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
    // The hit rebuilds the envelope from the cached code-derived part: no
    // decompilation, no artifact load and no block-number call, but the
    // proxy is re-resolved through RPC so the envelope carries the live
    // target, block and proxy details.
    expect(rpc.getCodeCalls.length).toBeGreaterThanOrEqual(codeCalls);
    expect(rpc.getStorageAtCalls.length).toBeGreaterThanOrEqual(storageCalls);
    expect(rpc.getBlockNumberCalls).toBe(blockCalls);
    expect(decompiler.callCount).toBe(decompilerCalls);
    expect(artifacts.loadCalls).toBe(artifactCalls);
    expect(second.value.envelope.target as string).toBe(first.value.envelope.target as string);
    expect(second.value.envelope.block as number).toBe(first.value.envelope.block as number);
    expect(second.value.envelope.proxy).toEqual(first.value.envelope.proxy);
    expect(second.value.envelope.codeHash as string).toBe(first.value.envelope.codeHash as string);
    expect(second.value.envelope.score as number).toBe(first.value.envelope.score as number);
    expect(second.value.envelope.probabilities).toEqual(first.value.envelope.probabilities);
  });

  test("k013_transient_decompiler_failure_skips_cache_store", async () => {
    // A-07/K-102: an envelope degraded by a wall-clock decompiler failure
    // must never populate the shared entry, so a later healthy run still
    // does the full work and stores the clean result.
    const target = mustOk(Address.parse(TARGET));
    const block = mustOk(BlockNumber.of(24000000));
    const rpc = new FakeRpcAdapter(new Map([[target as string, BYTECODE_HEX]]), block);
    const decompiler = new FakeDecompilerAdapter({ scenario: "timeout" });
    const cache = new InMemoryCacheAdapter();
    const services = createAppServices({
      rpc,
      modelArtifacts: new FakeModelArtifactAdapter(placeholderLoadedArtifact("0.1.0")),
      clock: new FakeClockAdapter(mustOk(Timestamp.of(1700000000000))),
      decompiler,
      cache,
    },
    mustDefaultDetectorSet());
    const version = mustOk(ModelVersion.parse("0.1.0"));
    const first = await services.analyzeToken(testInput(version));
    expect(first.ok).toBe(true);
    expect(cache.size()).toBe(0);
    decompiler.setScenario("success");
    const second = await services.analyzeToken(testInput(version));
    expect(second.ok).toBe(true);
    expect(decompiler.callCount).toBe(2);
    expect(cache.size()).toBe(1);
    if (!first.ok || first.value.kind !== "assessed" || !second.ok || second.value.kind !== "assessed") {
      throw new Error("expected assessed envelopes for the transient and the clean run");
    }
    expect(first.value.envelope.probabilities).toEqual(second.value.envelope.probabilities);
    expect(first.value.envelope.score).toBe(second.value.envelope.score);
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
    const services = createAppServices({ rpc, modelArtifacts: artifacts, clock, decompiler, cache },
  mustDefaultDetectorSet());

    const oldVersion = mustOk(ModelVersion.parse("0.1.0"));
    const newVersion = mustOk(ModelVersion.parse("0.2.0"));

    const firstOld = await services.analyzeToken(testInput(oldVersion));
    expect(firstOld.ok).toBe(true);
    const codeCallsAfterOld = rpc.getCodeCalls.length;
    expect(codeCallsAfterOld).toBeGreaterThan(0);

    const secondOld = await services.analyzeToken(testInput(oldVersion));
    expect(secondOld.ok).toBe(true);
    expect(rpc.getCodeCalls.length).toBeGreaterThanOrEqual(codeCallsAfterOld);

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
    expect(rpc.getCodeCalls.length).toBeGreaterThanOrEqual(codeCallsAfterNew);

    // The old entries stay usable beside the new ones.
    const thirdOld = await services.analyzeToken(testInput(oldVersion));
    expect(thirdOld.ok).toBe(true);
    expect(rpc.getCodeCalls.length).toBeGreaterThanOrEqual(codeCallsAfterNew);
  });

  test("k013_corrupt_cache_entry_falls_back_to_fresh_analysis", async () => {
    const target = mustOk(Address.parse(TARGET));
    const block = mustOk(BlockNumber.of(24000000));
    const rpc = new FakeRpcAdapter(new Map([[target as string, BYTECODE_HEX]]), block);
    const artifacts = new FakeModelArtifactAdapter(placeholderLoadedArtifact("0.1.0"));
    const clock = new FakeClockAdapter(mustOk(Timestamp.of(1700000000000)));
    const decompiler = new FakeDecompilerAdapter({ scenario: "success" });
    const cache = new FakeCacheAdapter();
    const services = createAppServices({ rpc, modelArtifacts: artifacts, clock, decompiler, cache },
  mustDefaultDetectorSet());

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
    expect(rpc.getCodeCalls.length).toBeGreaterThanOrEqual(recoveredCalls);
  });

  test("c20_impl_first_then_proxy_keeps_proxy_warning", async () => {
    // The implementation analysed directly carries no proxy warning and is
    // stored. The proxy resolving to the same code must still report its
    // own upgrade path: proxied runs never read or write the cache.
    const impl = mustOk(Address.parse(syntheticAddress(61)));
    const proxyAddr = mustOk(Address.parse(syntheticAddress(62)));
    const implCode = "0x6001600055";
    const proxyCode = "0x6001600a600b600c600d600e600f55";
    const wordOf = (raw: string): string => `0x${"0".repeat(24)}${raw.slice(2).toLowerCase()}`;
    const block = mustOk(BlockNumber.of(24000000));
    const cache = new InMemoryCacheAdapter();
    const services = createAppServices(
      {
        rpc: new FakeRpcAdapter(
          new Map<string, string>([
            [proxyAddr as string, proxyCode],
            [impl as string, implCode],
          ]),
          block,
          new Map([
            [
              proxyAddr as string,
              new Map([[(IMPLEMENTATION_SLOT as string).toLowerCase(), wordOf(impl as string)]]),
            ],
          ]),
        ),
        modelArtifacts: new FakeModelArtifactAdapter(placeholderLoadedArtifact("0.1.0")),
        clock: new FakeClockAdapter(mustOk(Timestamp.of(1700000000000))),
        cache,
      },
      mustDefaultDetectorSet(),
    );
    const version = mustOk(ModelVersion.parse("0.1.0"));
    const direct = await services.analyzeToken({ ...testInput(version), address: impl });
    expect(direct.ok).toBe(true);
    if (!direct.ok || direct.value.kind !== "assessed") {
      throw new Error("expected an assessed envelope for the implementation");
    }
    expect(direct.value.envelope.proxy.kind).toBe("none");
    expect(
      direct.value.envelope.pluginResults.some(
        (entry) => (entry.pluginId as string) === "dev.brandklipparen.proxy-upgrade" && entry.findings.length > 0,
      ),
    ).toBe(false);
    expect(cache.size()).toBe(1);

    const viaProxy = await services.analyzeToken({ ...testInput(version), address: proxyAddr });
    expect(viaProxy.ok).toBe(true);
    if (!viaProxy.ok || viaProxy.value.kind !== "assessed") {
      throw new Error("expected an assessed envelope for the proxy");
    }
    const proxy = viaProxy.value.envelope.proxy;
    expect(proxy.kind).toBe("eip1967");
    if (proxy.kind !== "eip1967") {
      throw new Error("expected an EIP-1967 proxy");
    }
    expect(proxy.implementation as string).toBe(impl as string);
    const facts = viaProxy.value.envelope.pluginResults.filter(
      (entry) => (entry.pluginId as string) === "dev.brandklipparen.proxy-upgrade",
    );
    expect(facts.length).toBeGreaterThan(0);
    expect(
      facts.every((entry) =>
        entry.findings.some(
          (finding) =>
            (finding.payload as { readonly implementation?: unknown })["implementation"] === (impl as string),
        ),
      ),
    ).toBe(true);
    // The proxied run is served fresh and never stored: same code, same
    // score, no new cache entry.
    expect(viaProxy.value.envelope.score as number).toBe(direct.value.envelope.score as number);
    expect(cache.size()).toBe(1);
  });

  test("c20_owner_named_after_cache_hit_for_second_address", async () => {
    // Same code at two addresses: the first has a zero owner word (stored
    // unenriched) while the second holds a proven owner. The code-hash
    // hit must re-read the owner for the second address and re-render the
    // explanation; score and probabilities never move with owner state.
    const code = c20GatedTokenHex();
    const firstAddr = mustOk(Address.parse(syntheticAddress(71)));
    const secondAddr = mustOk(Address.parse(syntheticAddress(72)));
    const owner = mustOk(Address.parse(syntheticAddress(73)));
    const ownerWord = c20AddressWord(owner as string);
    const block = mustOk(BlockNumber.of(24000000));
    const cache = new InMemoryCacheAdapter();
    const services = createAppServices(
      {
        rpc: new FakeRpcAdapter(
          new Map<string, string>([
            [firstAddr as string, code],
            [secondAddr as string, code],
          ]),
          block,
          new Map([[secondAddr as string, new Map([[C20_ZERO_SLOT, ownerWord]])]]),
          { calls: new Map([[C20_OWNER_FN, ownerWord]]) },
        ),
        modelArtifacts: c20Artifact(),
        clock: new FakeClockAdapter(mustOk(Timestamp.of(1700000000000))),
        cache,
      },
      mustDefaultDetectorSet(),
    );
    const inputFor = (address: typeof firstAddr, tail: string) => ({
      address,
      block,
      requestId: mustOk(RequestId.parse(`123e4567-e89b-12d3-a456-42661417${tail}`)),
      deadline: mustOk(Timestamp.of(1700000005000)),
      modelVersion: mustOk(ModelVersion.parse("0.1.0-c20.test")),
      indexVersion: mustOk(IndexVersion.parse("1.0.0")),
      templateVersion: mustOk(TemplateVersion.parse("1.1.0")),
      catalogue: TEST_CATALOGUE,
    });
    const first = await services.analyzeToken(inputFor(firstAddr, "4301"));
    expect(first.ok).toBe(true);
    if (!first.ok || first.value.kind !== "assessed") {
      throw new Error("expected an assessed envelope for the first address");
    }
    expect(cache.size()).toBe(1);
    for (const signal of first.value.envelope.signals) {
      expect(signal.kind === "capability" ? signal.temporality.kind : "can-change-unknown").toBe(
        "can-change-unknown",
      );
    }
    for (const claim of first.value.envelope.explanation.claims) {
      expect(claim.text.toLowerCase().includes((owner as string).slice(2).toLowerCase())).toBe(false);
    }

    const second = await services.analyzeToken(inputFor(secondAddr, "4302"));
    expect(second.ok).toBe(true);
    if (!second.ok || second.value.kind !== "assessed") {
      throw new Error("expected an assessed envelope for the second address");
    }
    const mint = c20GatedMintSignals(second.value.envelope.signals);
    expect(mint.length).toBeGreaterThan(0);
    for (const signal of mint) {
      if (signal.kind !== "capability") {
        throw new Error("expected capability mint signals");
      }
      expect(signal.temporality).toEqual({ kind: "can-change", changer: owner as string });
    }
    const now = second.value.envelope.signals.filter(
      (signal) => signal.kind === "capability" && signal.temporality.kind === "applies-now",
    );
    expect(now).toHaveLength(1);
    const mintIds = new Set(mint.map((signal) => signal.id as string));
    const mintClaims = second.value.envelope.explanation.claims.filter(
      (claim) =>
        claim.signalLinks.some((link) => mintIds.has(link as string)) && claim.text.includes(C20_TRANSFER),
    );
    expect(mintClaims.length).toBeGreaterThan(0);
    for (const claim of mintClaims) {
      expect(claim.text.includes(owner as string)).toBe(true);
    }
    // Only the chain state differs: findings, score and probabilities are
    // identical, and the enriched hit is never stored.
    expect(second.value.envelope.pluginResults).toEqual(first.value.envelope.pluginResults);
    expect(second.value.envelope.score as number).toBe(first.value.envelope.score as number);
    expect(second.value.envelope.probabilities).toEqual(first.value.envelope.probabilities);
    expect(cache.size()).toBe(1);
  });

  test("c20_owner_read_failure_not_cached", async () => {
    // A storage outage leaves the run assessed but degraded; the entry
    // must never reach the cache, so a later healthy run still re-reads.
    const target = mustOk(Address.parse(syntheticAddress(81)));
    const block = mustOk(BlockNumber.of(24000000));
    const rpc = new FailingStorageRpc(
      new Map<string, string>([[target as string, c20GatedTokenHex()]]),
      block,
    );
    const cache = new FakeCacheAdapter();
    const services = createAppServices(
      {
        rpc,
        modelArtifacts: c20Artifact(),
        clock: new FakeClockAdapter(mustOk(Timestamp.of(1700000000000))),
        cache,
      },
      mustDefaultDetectorSet(),
    );
    const input = {
      address: target,
      block,
      requestId: mustOk(RequestId.parse("123e4567-e89b-12d3-a456-426614174401")),
      deadline: mustOk(Timestamp.of(1700000005000)),
      modelVersion: mustOk(ModelVersion.parse("0.1.0-c20.test")),
      indexVersion: mustOk(IndexVersion.parse("1.0.0")),
      templateVersion: mustOk(TemplateVersion.parse("1.1.0")),
      catalogue: TEST_CATALOGUE,
    };
    const first = await services.analyzeToken(input);
    expect(first.ok).toBe(true);
    if (!first.ok || first.value.kind !== "assessed") {
      throw new Error("expected an assessed envelope despite the storage outage");
    }
    expect(cache.putCalls).toBe(0);
    const second = await services.analyzeToken({
      ...input,
      requestId: mustOk(RequestId.parse("123e4567-e89b-12d3-a456-426614174402")),
    });
    expect(second.ok).toBe(true);
    expect(cache.putCalls).toBe(0);
  });
});

// C-20 fixtures: a gated token (privileged mint plus `owner()`), the
// artifact scoring ownership and mint, and an RPC whose storage reads
// always fail.
const C20_MINT = "0x40c10f19";
const C20_TRANSFER = "0xa9059cbb";
const C20_OWNER_FN = "0x8da5cb5b";
const C20_ZERO_SLOT = `0x${"0".repeat(64)}`;

function c20MintBody(): number[] {
  return [
    ...ownerGuard(0, 200),
    CALLDATALOAD,
    ...push1(1),
    SLOAD,
    ADD,
    ...sstoreConstSlot(1, []),
    CALLDATALOAD,
    ...push1(2),
    KECCAK,
    SSTORE,
    STOP,
  ];
}

function c20GatedTransferBody(): number[] {
  return [CALLDATALOAD, ...push1(1), SLOAD, ADD, ...sstoreConstSlot(2, [CALLDATALOAD]), STOP];
}

function c20GatedTokenHex(): string {
  const bytecode = tokenBytecode([
    { selector: C20_MINT, body: c20MintBody() },
    { selector: C20_TRANSFER, body: c20GatedTransferBody() },
    { selector: C20_OWNER_FN, body: [STOP] },
  ]);
  return `0x${Buffer.from(bytecode).toString("hex")}`;
}

function c20Artifact(): FakeModelArtifactAdapter {
  const artifact = mustOk(
    parseModelArtifact({
      version: "0.1.0-c20.test",
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
      pluginWeights: { "dev.brandklipparen.mint": 0.9, "dev.brandklipparen.ownership": 0.9 },
      pluginFeatureCatalogue: {
        "dev.brandklipparen.mint": { risk: "rug-pull", direction: "raises", severity: "high" },
        "dev.brandklipparen.ownership": { risk: "rug-pull", direction: "raises", severity: "high" },
      },
    }),
  );
  return new FakeModelArtifactAdapter(
    Object.freeze({ artifact, checksum: mustOk(ArtifactChecksum.parse("cd".repeat(32))) }),
  );
}

function c20AddressWord(owner: string): string {
  return `0x${"0".repeat(24)}${owner.slice(2).toLowerCase()}`;
}

function c20GatedMintSignals(signals: readonly Signal[]): Signal[] {
  return signals.filter(
    (signal) =>
      signal.kind === "capability" &&
      signal.risk === "rug-pull" &&
      signal.severity === "high" &&
      signal.evidence.some((entry) => (entry.selector as string) === C20_MINT) &&
      signal.evidence.some((entry) => (entry.selector as string) === C20_TRANSFER),
  );
}

class FailingStorageRpc extends FakeRpcAdapter {
  override async getStorageAt(): Promise<Result<StorageWordType, RpcError>> {
    return err({ kind: "timeout", message: "fake storage outage for the c20 read-failure drill" });
  }
}
