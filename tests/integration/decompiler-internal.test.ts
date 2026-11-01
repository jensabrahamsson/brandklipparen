// Deepening through the internal decompiler adapter (K-008, K-501,
// K-521, C-16r). A successful run links snippets to signal evidence; a
// run over the input cap yields the hard-to-analyze finding as a display
// record with the fast path's response standing; unresolved control flow
// is normal compiler output, so it resolves ok with the snippets kept
// and raises no hard-to-analyze signal. Only a genuine inability to
// analyse (steered by fakes in tests) still raises the scored signal.
// Pathological input stays bounded in-process with caps, so parallel
// analyses continue. All fixtures are synthetic and hand-assembled.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test, vi } from "vitest";
import { InternalDecompilerAdapter } from "../../src/adapters/decompiler/internalDecompilerAdapter.ts";
import { InMemoryCacheAdapter } from "../../src/adapters/cache/inMemoryCache.ts";
import { createAppServices } from "../../src/application/analyzeToken.ts";
import type { Result } from "../../src/domain/result.ts";
import { decompileContractV2 } from "../../src/domain/decompileV2.ts";
import { parseModelArtifact } from "../../src/domain/risk.ts";
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
import type { CapabilityCatalogue, Signal } from "../../src/domain/signals.ts";
import type { LoadedArtifact } from "../../src/ports/modelArtifact.ts";
import { FakeClockAdapter } from "../fakes/fakeClock.ts";
import { FakeDecompilerAdapter } from "../fakes/fakeDecompiler.ts";
import { FakeModelArtifactAdapter } from "../fakes/fakeModelArtifact.ts";
import { FakeRpcAdapter } from "../fakes/fakeRpc.ts";
import { mustDefaultDetectorSet } from "../helpers/detectorSets.ts";
import { Asm } from "../helpers/evmAsm.ts";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..");
const corpusDir = join(repoRoot, "tests", "fixtures", "evm", "corpus");

function mustOk<T, E extends { message: string }>(result: Result<T, E>): T {
  if (!result.ok) {
    throw new Error(`expected ok, got error: ${result.error.message}`);
  }
  return result.value;
}

// Frozen placeholder artifact for tests only: small synthetic numbers with
// no predictive meaning. Production values arrive through the versioned
// model artifact per K-210; the deepening only reads the frozen value.
function placeholderLoadedArtifact(): LoadedArtifact {
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
  return Object.freeze({
    artifact,
    checksum: mustOk(ArtifactChecksum.parse("ab".repeat(32))),
  });
}

// Placeholder catalogue for tests only: the risk, direction and severity
// mapping steers scoring, so production passes the versioned artifact
// mapping per K-210 and A-20.
const TEST_CATALOGUE: CapabilityCatalogue = Object.freeze({
  selfdestruct: Object.freeze({ risk: "rug-pull", direction: "raises", severity: "high" }),
  delegatecall: Object.freeze({ risk: "rug-pull", direction: "raises", severity: "high" }),
  call: Object.freeze({ risk: "honeypot", direction: "raises", severity: "medium" }),
  "storage-write": Object.freeze({ risk: "bot-pump", direction: "raises", severity: "low" }),
});

const TARGET = "0x0102030405060708090a0b0c0d0e0f1011121314";
// Hand-assembled synthetic dispatcher with two entries: transfer
// (0xa9059cbb) and balanceOf (0x70a08231), and clean static control
// flow, so the internal engine decompiles it fully.
const DISPATCHER_BYTECODE =
  "0x608060405234801561001057600080fd5b508063a9059cbb1461002d57806370a0823114610047575b600080fd5b600035331461003b57600080fd5b60015460023501600155005b6000355460005260206000f3";

function hardToAnalyzeSignals(signals: readonly Signal[]): Extract<Signal, { kind: "hard-to-analyze" }>[] {
  return signals.filter((signal): signal is Extract<Signal, { kind: "hard-to-analyze" }> => signal.kind === "hard-to-analyze");
}

function inputOf() {
  return {
    address: mustOk(Address.parse(TARGET)),
    block: mustOk(BlockNumber.of(24000000)),
    requestId: mustOk(RequestId.parse("123e4567-e89b-12d3-a456-426614174000")),
    deadline: mustOk(Timestamp.of(4102444800000)),
    modelVersion: mustOk(ModelVersion.parse("0.1.0")),
    indexVersion: mustOk(IndexVersion.parse("1.0.0")),
    templateVersion: mustOk(TemplateVersion.parse("1.0.0")),
    catalogue: TEST_CATALOGUE,
  } as const;
}

describe("internal decompiler deepening in the application service (K-008, K-501)", () => {
  test("k008_internal_decompilation_links_snippets_to_evidence", async () => {
    const target = mustOk(Address.parse(TARGET));
    const block = mustOk(BlockNumber.of(24000000));
    const services = createAppServices({
      rpc: new FakeRpcAdapter(new Map([[target as string, DISPATCHER_BYTECODE]]), block),
      modelArtifacts: new FakeModelArtifactAdapter(placeholderLoadedArtifact()),
      clock: new FakeClockAdapter(mustOk(Timestamp.of(1700000000000))),
      decompiler: new InternalDecompilerAdapter(),
    },
    mustDefaultDetectorSet());
    const analysed = await services.analyzeToken(inputOf());
    expect(analysed.ok).toBe(true);
    if (!analysed.ok || analysed.value.kind !== "assessed") {
      throw new Error("expected an assessed envelope after a successful internal decompilation");
    }
    const envelope = analysed.value.envelope;
    expect(hardToAnalyzeSignals(envelope.signals)).toEqual([]);
    const snippets = envelope.signals.flatMap((signal) =>
      signal.evidence.map((entry) => entry.snippet?.text ?? ""),
    );
    expect(snippets.some((text) => text.length > 0)).toBe(true);
    expect(Number.isInteger(envelope.score as number)).toBe(true);
  });

  test("k008_internal_limits_yield_typed_finding_without_signal", async () => {
    const target = mustOk(Address.parse(TARGET));
    const block = mustOk(BlockNumber.of(24000000));
    const services = createAppServices({
      rpc: new FakeRpcAdapter(new Map([[target as string, DISPATCHER_BYTECODE]]), block),
      modelArtifacts: new FakeModelArtifactAdapter(placeholderLoadedArtifact()),
      clock: new FakeClockAdapter(mustOk(Timestamp.of(1700000000000))),
      decompiler: new InternalDecompilerAdapter({ maxBytesIn: 8 }),
    },
    mustDefaultDetectorSet());
    // An input-cap failure is a domain outcome, not an analysis
    // failure: the call resolves to an assessed envelope. The cap cause
    // never reaches the score (A-07, K-102): no hard-to-analyze signal
    // is emitted, while the finding stays in pluginResults.
    const analysed = await services.analyzeToken(inputOf());
    expect(analysed.ok).toBe(true);
    if (!analysed.ok || analysed.value.kind !== "assessed") {
      throw new Error("expected an assessed envelope after an input-cap decompilation failure");
    }
    const envelope = analysed.value.envelope;
    expect(hardToAnalyzeSignals(envelope.signals)).toEqual([]);
    const hardEntry = envelope.pluginResults.find(
      (entry) => entry.pluginId === "dev.brandklipparen.hard-to-analyze",
    );
    expect(hardEntry?.outcome).toBe("ok");
    expect(
      hardEntry?.findings.map((finding) => (finding.payload as { cause?: unknown }).cause),
    ).toEqual(["resource-limit"]);
    expect(envelope.probabilities["rug-pull"] as number).toBeGreaterThanOrEqual(0);
    expect(Number.isInteger(envelope.score as number)).toBe(true);
  });

  test("c16_unresolved_control_flow_is_not_hard_to_analyze", async () => {
    // Frozen corpus fixture with one recorded unresolved jump (C-16r):
    // unresolved jumps are normal compiler output, so the adapter
    // resolves ok, the analysis carries no hard-to-analyze signal, and
    // the rendered functions are present as snippets.
    const bytecode = readFileSync(join(corpusDir, "edge-invalid.hex"), "utf8").trim();
    const target = mustOk(Address.parse(TARGET));
    const block = mustOk(BlockNumber.of(24000000));
    const adapter = new InternalDecompilerAdapter();
    const parsed = mustOk(Bytecode.parse(bytecode));
    const direct = await adapter.decompile(
      parsed,
      mustOk(CodeHash.of(parsed)),
      {
        requestId: mustOk(RequestId.parse("123e4567-e89b-12d3-a456-426614174000")),
        deadline: mustOk(Timestamp.of(4102444800000)),
        block: mustOk(BlockNumber.of(24000000)),
      },
    );
    expect(direct.ok).toBe(true);
    if (!direct.ok) {
      throw new Error("expected the internal decompiler to resolve ok on unresolved control flow");
    }
    expect(direct.value.functions.length).toBeGreaterThan(0);
    for (const fn of direct.value.functions) {
      expect(fn.snippet.text).toContain(`/* selector ${fn.selector as string} */`);
    }
    const services = createAppServices({
      rpc: new FakeRpcAdapter(new Map([[target as string, bytecode]]), block),
      modelArtifacts: new FakeModelArtifactAdapter(placeholderLoadedArtifact()),
      clock: new FakeClockAdapter(mustOk(Timestamp.of(1700000000000))),
      decompiler: adapter,
    },
    mustDefaultDetectorSet());
    const analysed = await services.analyzeToken(inputOf());
    expect(analysed.ok).toBe(true);
    if (!analysed.ok || analysed.value.kind !== "assessed") {
      throw new Error("expected an assessed envelope after an unresolved-flow decompilation");
    }
    const envelope = analysed.value.envelope;
    expect(hardToAnalyzeSignals(envelope.signals)).toEqual([]);
    expect(envelope.probabilities["rug-pull"] as number).toBeGreaterThanOrEqual(0);
    expect(Number.isInteger(envelope.score as number)).toBe(true);
  });

  test("c16_solc_shaped_internal_returns_match_no_decompiler", async () => {
    // Solc-shaped synthetic contract with a shared internal helper
    // (rebuilt from the reachV2 shared-return shape with Asm): v1 leaves
    // the helper return unresolved, which must not raise
    // hard-to-analyze, so analysing with the internal decompiler gives
    // the identical score and probabilities as analysing without one.
    const asm = new Asm();
    asm.op(0x80).push4("a9059cbb").op(0x14);
    asm.pushLabel2("transferEntry").op(0x57);
    asm.op(0x80).push4("23b872dd").op(0x14);
    asm.pushLabel2("transferFromEntry").op(0x57);
    asm.label("fallback");
    asm.op(0x5b).push1(0x00).op(0x80, 0xfd);
    asm.label("transferEntry").op(0x5b);
    asm.pushLabel2("ret1");
    asm.pushLabel2("shared");
    asm.op(0x56);
    asm.label("transferFromEntry").op(0x5b);
    asm.pushLabel2("ret2");
    asm.pushLabel2("shared");
    asm.op(0x56);
    asm.label("shared");
    asm.op(0x5b);
    asm.push1(0x01).push1(0x02).op(0x01);
    asm.op(0x56);
    asm.op(0xfe);
    asm.label("ret1").op(0x5b);
    asm.push1(0x01).push1(0x00);
    asm.op(0x55, 0x00);
    asm.label("ret2").op(0x5b);
    asm.push1(0x02).push1(0x00);
    asm.op(0x55, 0x00);
    const hex = asm.build();
    // The fixture really carries an unresolved v1 jump: without that
    // the test would prove nothing about the C-16r rule.
    expect(decompileContractV2(mustOk(Bytecode.parse(hex))).unresolvedJumps.length).toBeGreaterThan(0);
    const target = mustOk(Address.parse(TARGET));
    const block = mustOk(BlockNumber.of(24000000));
    const portsWith = {
      rpc: new FakeRpcAdapter(new Map([[target as string, hex]]), block),
      modelArtifacts: new FakeModelArtifactAdapter(placeholderLoadedArtifact()),
      clock: new FakeClockAdapter(mustOk(Timestamp.of(1700000000000))),
      decompiler: new InternalDecompilerAdapter(),
    };
    const portsWithout = {
      rpc: new FakeRpcAdapter(new Map([[target as string, hex]]), block),
      modelArtifacts: new FakeModelArtifactAdapter(placeholderLoadedArtifact()),
      clock: new FakeClockAdapter(mustOk(Timestamp.of(1700000000000))),
    };
    const [withDecompiler, withoutDecompiler] = await Promise.all([
      createAppServices(portsWith, mustDefaultDetectorSet()).analyzeToken(inputOf()),
      createAppServices(portsWithout, mustDefaultDetectorSet()).analyzeToken(inputOf()),
    ]);
    expect(withDecompiler.ok).toBe(true);
    expect(withoutDecompiler.ok).toBe(true);
    if (
      !withDecompiler.ok || withDecompiler.value.kind !== "assessed" ||
      !withoutDecompiler.ok || withoutDecompiler.value.kind !== "assessed"
    ) {
      throw new Error("expected assessed envelopes with and without the internal decompiler");
    }
    expect(hardToAnalyzeSignals(withDecompiler.value.envelope.signals)).toEqual([]);
    expect(withDecompiler.value.envelope.score).toBe(withoutDecompiler.value.envelope.score);
    expect(withDecompiler.value.envelope.probabilities).toEqual(
      withoutDecompiler.value.envelope.probabilities,
    );
  });

  test("c16_oversize_input_is_transient", async () => {
    // Bytecode over the adapter input cap (C-16r): the resource-limit
    // cause stays transient, so the analysis carries no scored signal
    // and the run stores nothing in the shared cache.
    const target = mustOk(Address.parse(TARGET));
    const block = mustOk(BlockNumber.of(24000000));
    const cache = new InMemoryCacheAdapter();
    const putSpy = vi.spyOn(cache, "put");
    const services = createAppServices({
      rpc: new FakeRpcAdapter(new Map([[target as string, DISPATCHER_BYTECODE]]), block),
      modelArtifacts: new FakeModelArtifactAdapter(placeholderLoadedArtifact()),
      clock: new FakeClockAdapter(mustOk(Timestamp.of(1700000000000))),
      decompiler: new InternalDecompilerAdapter({ maxBytesIn: 8 }),
      cache,
    },
    mustDefaultDetectorSet());
    const analysed = await services.analyzeToken(inputOf());
    expect(analysed.ok).toBe(true);
    if (!analysed.ok || analysed.value.kind !== "assessed") {
      throw new Error("expected an assessed envelope after an over-cap decompilation");
    }
    const envelope = analysed.value.envelope;
    expect(hardToAnalyzeSignals(envelope.signals)).toEqual([]);
    const hardEntry = envelope.pluginResults.find(
      (entry) => entry.pluginId === "dev.brandklipparen.hard-to-analyze",
    );
    expect(hardEntry?.outcome).toBe("ok");
    expect(
      hardEntry?.findings.map((finding) => (finding.payload as { cause?: unknown }).cause),
    ).toEqual(["resource-limit"]);
    expect(putSpy).not.toHaveBeenCalled();
  });

  test("c16_genuine_decompiler_failure_still_raises_hard_to_analyze", async () => {
    // A genuine inability to analyse (C-16r): an invalid-output failure
    // from the decompiler still maps to the scored decompiler-error
    // cause, so only hostile input reaches the hard-to-analyze signal.
    const target = mustOk(Address.parse(TARGET));
    const block = mustOk(BlockNumber.of(24000000));
    const services = createAppServices({
      rpc: new FakeRpcAdapter(new Map([[target as string, DISPATCHER_BYTECODE]]), block),
      modelArtifacts: new FakeModelArtifactAdapter(placeholderLoadedArtifact()),
      clock: new FakeClockAdapter(mustOk(Timestamp.of(1700000000000))),
      decompiler: new FakeDecompilerAdapter({ scenario: "invalid-output" }),
    },
    mustDefaultDetectorSet());
    const analysed = await services.analyzeToken(inputOf());
    expect(analysed.ok).toBe(true);
    if (!analysed.ok || analysed.value.kind !== "assessed") {
      throw new Error("expected an assessed envelope after a genuine decompilation failure");
    }
    const envelope = analysed.value.envelope;
    expect(
      hardToAnalyzeSignals(envelope.signals).map((signal) => signal.cause),
    ).toEqual(["decompiler-error"]);
    expect(Number.isInteger(envelope.score as number)).toBe(true);
  });

  test("k501_pathological_input_stays_bounded_in_process", async () => {
    // Deterministic hostile shapes: a jump-loop soup that exercises the
    // engine caps, an oversized input past the port cap, and the clean
    // dispatcher beside them. Every run resolves in-process to an
    // assessed envelope, so parallel analyses continue.
    const loopSoup = `0x${"5b600156".repeat(2500)}`;
    const oversized = `0x${"6000".repeat(10000)}`;
    const block = mustOk(BlockNumber.of(24000000));
    const services = (bytecode: string) => createAppServices({
      rpc: new FakeRpcAdapter(new Map([[mustOk(Address.parse(TARGET)) as string, bytecode]]), block),
      modelArtifacts: new FakeModelArtifactAdapter(placeholderLoadedArtifact()),
      clock: new FakeClockAdapter(mustOk(Timestamp.of(1700000000000))),
      decompiler: new InternalDecompilerAdapter(),
    },
    mustDefaultDetectorSet());
    const started = Date.now();
    const [clean, looping, huge] = await Promise.all([
      services(DISPATCHER_BYTECODE).analyzeToken(inputOf()),
      services(loopSoup).analyzeToken(inputOf()),
      services(oversized).analyzeToken(inputOf()),
    ]);
    const elapsed = Date.now() - started;
    for (const result of [clean, looping, huge]) {
      expect(result.ok && result.value.kind === "assessed").toBe(true);
    }
    expect(elapsed).toBeLessThan(15000);
  });

  test("k008_fake_timeout_skips_signal_without_engine", async () => {
    const target = mustOk(Address.parse(TARGET));
    const block = mustOk(BlockNumber.of(24000000));
    const fake = new FakeDecompilerAdapter({ scenario: "timeout" });
    const services = createAppServices({
      rpc: new FakeRpcAdapter(new Map([[target as string, DISPATCHER_BYTECODE]]), block),
      modelArtifacts: new FakeModelArtifactAdapter(placeholderLoadedArtifact()),
      clock: new FakeClockAdapter(mustOk(Timestamp.of(1700000000000))),
      decompiler: fake,
    },
    mustDefaultDetectorSet());
    const analysed = await services.analyzeToken(inputOf());
    expect(analysed.ok).toBe(true);
    if (!analysed.ok || analysed.value.kind !== "assessed") {
      throw new Error("expected an assessed envelope after a fake decompilation timeout");
    }
    expect(hardToAnalyzeSignals(analysed.value.envelope.signals)).toEqual([]);
    const hardEntry = analysed.value.envelope.pluginResults.find(
      (entry) => entry.pluginId === "dev.brandklipparen.hard-to-analyze",
    );
    expect(
      hardEntry?.findings.map((finding) => (finding.payload as { cause?: unknown }).cause),
    ).toEqual(["timeout"]);
    expect(fake.callCount).toBe(1);
  });
});
