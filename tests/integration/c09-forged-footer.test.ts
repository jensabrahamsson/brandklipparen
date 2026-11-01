// Forged CBOR footer (F-3, part 1; C-9): bytecode that hides referenced
// code inside a strictly valid metadata-shaped tail must analyse the full
// bytes and carry a scored `obfuscated-structure` signal, while bytecode
// with a real solc footer analyses the prefix and stays silent. All byte
// sequences below are small hand-assembled synthetic values built in this
// file: no real contract bytecode and no external data.
import { describe, expect, test } from "vitest";
import { InMemoryCacheAdapter } from "../../src/adapters/cache/inMemoryCache.ts";
import { createAppServices } from "../../src/application/analyzeToken.ts";
import type { Result } from "../../src/domain/result.ts";
import { parseModelArtifact } from "../../src/domain/risk.ts";
import type { Signal } from "../../src/domain/signals.ts";
import type { CapabilityCatalogue } from "../../src/domain/signals.ts";
import {
  Address,
  ArtifactChecksum,
  BlockNumber,
  IndexVersion,
  ModelVersion,
  RequestId,
  TemplateVersion,
  Timestamp,
} from "../../src/domain/types.ts";
import type { ModelVersion as ModelVersionType } from "../../src/domain/types.ts";
import type {
  LoadedArtifact,
} from "../../src/ports/modelArtifact.ts";
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

const TEST_CATALOGUE: CapabilityCatalogue = Object.freeze({
  selfdestruct: Object.freeze({ risk: "rug-pull", direction: "raises", severity: "high" }),
  delegatecall: Object.freeze({ risk: "rug-pull", direction: "raises", severity: "high" }),
  call: Object.freeze({ risk: "honeypot", direction: "raises", severity: "medium" }),
  "storage-write": Object.freeze({ risk: "bot-pump", direction: "raises", severity: "low" }),
});

const TARGET = "0x0102030405060708090a0b0c0d0e0f1011121314";

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

function hexOf(bytes: readonly number[]): string {
  return `0x${bytes.map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

// Dispatcher prefix whose entry targets a JUMPDEST hidden inside the
// footer below: DUP1 PUSH4 0xa9059cbb EQ PUSH2 0x0015 JUMPI.
const FORGED_PREFIX = [0x80, 0x63, 0xa9, 0x05, 0x9c, 0xbb, 0x14, 0x61, 0x00, 0x15, 0x57];

// Strictly valid {ipfs, solc} footer whose 34-byte hash region hides a
// JUMPDEST at content index 2 (absolute PC 0x15 = 21).
function footerHidingJumpdest(): number[] {
  const content = new Array<number>(34).fill(0x00);
  content[2] = 0x5b;
  return [
    0xa2, 0x64, 0x69, 0x70, 0x66, 0x73, 0x58, 0x22, ...content,
    0x64, 0x73, 0x6f, 0x6c, 0x63, 0x43, 0x00, 0x08, 0x09, 0x00, 0x33,
  ];
}

const FORGED_BYTECODE = hexOf([...FORGED_PREFIX, ...footerHidingJumpdest()]);

// Same dispatcher shape with a real solc 0.8 footer (hash region carries
// no code reference): the footer stays excluded and silent.
const CLEAN_PREFIX = [0x80, 0x63, 0xa9, 0x05, 0x9c, 0xbb, 0x14, 0x60, 0x0a, 0x57, 0x5b, 0x00];

function realSolcFooter(): number[] {
  const content = new Array<number>(34).fill(0x22);
  return [
    0xa2, 0x64, 0x69, 0x70, 0x66, 0x73, 0x58, 0x22, ...content,
    0x64, 0x73, 0x6f, 0x6c, 0x63, 0x43, 0x00, 0x08, 0x15, 0x00, 0x33,
  ];
}

const CLEAN_BYTECODE = hexOf([...CLEAN_PREFIX, ...realSolcFooter()]);

function hardCauses(signals: readonly Signal[]): unknown[] {
  return signals
    .filter((signal) => signal.kind === "hard-to-analyze")
    .map((signal) =>
      signal.kind === "hard-to-analyze" ? signal.cause : null,
    );
}

describe("c09 forged CBOR footer analysis (F-3, part 1)", () => {
  test("c09_forged_footer_emits_obfuscated_structure", async () => {
    const target = mustOk(Address.parse(TARGET));
    const block = mustOk(BlockNumber.of(24000000));
    const services = createAppServices(
      {
        rpc: new FakeRpcAdapter(new Map([[target as string, FORGED_BYTECODE]]), block),
        modelArtifacts: new FakeModelArtifactAdapter(placeholderLoadedArtifact("0.1.0")),
        clock: new FakeClockAdapter(mustOk(Timestamp.of(1700000000000))),
        decompiler: new FakeDecompilerAdapter({ scenario: "success" }),
        cache: new InMemoryCacheAdapter(),
      },
      mustDefaultDetectorSet(),
    );
    const analysed = await services.analyzeToken(testInput(mustOk(ModelVersion.parse("0.1.0"))));
    expect(analysed.ok).toBe(true);
    if (!analysed.ok || analysed.value.kind !== "assessed") {
      throw new Error("expected an assessed envelope for the forged footer");
    }
    const envelope = analysed.value.envelope;
    expect(hardCauses(envelope.signals)).toContain("obfuscated-structure");
    const causes = envelope.pluginResults
      .filter((entry) => entry.outcome === "ok")
      .flatMap((entry) =>
        entry.outcome === "ok" ? entry.findings.map((finding) => finding.payload) : [],
      );
    expect(
      causes.some(
        (payload) =>
          typeof payload === "object" &&
          payload !== null &&
          (payload as { cause?: unknown }).cause === "obfuscated-structure",
      ),
    ).toBe(true);
  });

  test("c09_real_footer_stays_silent", async () => {
    const target = mustOk(Address.parse(TARGET));
    const block = mustOk(BlockNumber.of(24000000));
    const services = createAppServices(
      {
        rpc: new FakeRpcAdapter(new Map([[target as string, CLEAN_BYTECODE]]), block),
        modelArtifacts: new FakeModelArtifactAdapter(placeholderLoadedArtifact("0.1.0")),
        clock: new FakeClockAdapter(mustOk(Timestamp.of(1700000000000))),
        decompiler: new FakeDecompilerAdapter({ scenario: "success" }),
        cache: new InMemoryCacheAdapter(),
      },
      mustDefaultDetectorSet(),
    );
    const analysed = await services.analyzeToken(testInput(mustOk(ModelVersion.parse("0.1.0"))));
    expect(analysed.ok).toBe(true);
    if (!analysed.ok || analysed.value.kind !== "assessed") {
      throw new Error("expected an assessed envelope for the real footer");
    }
    expect(hardCauses(analysed.value.envelope.signals)).toEqual([]);
  });
});
