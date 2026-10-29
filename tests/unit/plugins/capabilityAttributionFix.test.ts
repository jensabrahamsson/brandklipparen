// Part A regression tests: capability attribution and honest changer.
// A CALL occurrence that cannot be paired with the function body holding
// it must be skipped, never guessed through a positional fallback. The
// changer of a capability signal comes from the ownership proof (the live
// owner address), and ownerless code carries changerless temporality.
import { describe, expect, test } from "vitest";
import { Address, BlockNumber, Bytecode, CodeHash, IndexVersion, ModelVersion, RequestId, TemplateVersion, Timestamp } from "../../../src/domain/types.ts";
import type { Result } from "../../../src/domain/result.ts";
import { detectCapabilities } from "../../../src/domain/signals.ts";
import type { CapabilityCatalogue } from "../../../src/domain/signals.ts";
import { capabilityDetectorPlugin } from "../../../src/plugins/detectors/capability/index.ts";
import type { DetectorInput } from "../../../src/plugins/detector.ts";
import { createAppServices } from "../../../src/application/analyzeToken.ts";
import { FileModelArtifactAdapter } from "../../../src/adapters/model/fileArtifact.ts";
import { FakeClockAdapter } from "../../fakes/fakeClock.ts";
import { FakeModelArtifactAdapter } from "../../fakes/fakeModelArtifact.ts";
import { FakeRpcAdapter } from "../../fakes/fakeRpc.ts";
import { parseModelArtifact } from "../../../src/domain/risk.ts";
import { ArtifactChecksum } from "../../../src/domain/types.ts";
import { mustDefaultDetectorSet } from "../../helpers/detectorSets.ts";
import { syntheticAddress } from "../../helpers/syntheticAddresses.ts";
import { CALL, CALLDATALOAD, STOP, ownerGuard, sstoreConstSlot, tokenBytecode } from "../../helpers/ownerControlFixtures.ts";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..", "..");

function mustOk<T, E extends { message: string }>(result: Result<T, E>): T {
  if (!result.ok) {
    throw new Error(`expected ok, got error: ${result.error.message}`);
  }
  return result.value;
}

const TEST_CATALOGUE: CapabilityCatalogue = Object.freeze({
  selfdestruct: Object.freeze({ risk: "rug-pull", direction: "raises", severity: "high" }),
  delegatecall: Object.freeze({ risk: "rug-pull", direction: "raises", severity: "high" }),
  call: Object.freeze({ risk: "honeypot", direction: "raises", severity: "medium" }),
  "storage-write": Object.freeze({ risk: "bot-pump", direction: "raises", severity: "low" }),
});

// Two-selector dispatcher (0x06fdde03 -> PC 48, 0xa9059cbb -> PC 64) with
// a single CALL sitting at PC 30 in the padding between the dispatcher
// windows and the first body: no paired function holds it, so honest
// attribution skips it instead of guessing a selector.
function strayCallBytes(): number[] {
  const body: number[] = [
    0x80, 0x63, 0x06, 0xfd, 0xde, 0x03, 0x14, 0x61, 0x00, 0x30, 0x57,
    0x80, 0x63, 0xa9, 0x05, 0x9c, 0xbb, 0x14, 0x61, 0x00, 0x40, 0x57,
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0xf1, 0x00,
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x5b,
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00, 0x00,
    0x5b,
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
  ];
  return body;
}

function strayCallCode() {
  const hex = strayCallBytes().map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return mustOk(Bytecode.parse(`0x${hex}`));
}

describe("capability attribution skips unattributable occurrences", () => {
  test("detector plugin reports no finding for a stray CALL outside every function body", () => {
    const bytecode = strayCallCode();
    const input: DetectorInput = Object.freeze({
      bytecode,
      codeHash: mustOk(CodeHash.of(bytecode)),
    });
    expect(capabilityDetectorPlugin.detect(input)).toEqual([]);
  });

  test("domain sweep reports no signal for a stray CALL outside every function body", () => {
    const bytecode = strayCallCode();
    const changer = mustOk(Address.parse(syntheticAddress(11)));
    const signals = detectCapabilities(bytecode, mustOk(CodeHash.of(bytecode)), TEST_CATALOGUE, {
      kind: "can-change",
      changer,
    });
    expect(signals).toEqual([]);
  });

  test("an attributable CALL in a paired body still reports its holding function", () => {
    const bytecode = tokenBytecode([
      { selector: "0x06fdde03", body: [CALLDATALOAD, STOP] },
      { selector: "0xa9059cbb", body: [CALLDATALOAD, CALL, STOP] },
    ]);
    const input: DetectorInput = Object.freeze({
      bytecode,
      codeHash: mustOk(CodeHash.of(bytecode)),
    });
    const findings = capabilityDetectorPlugin.detect(input);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.payload).toEqual({ capability: "call" });
    expect(findings[0]?.evidence[0]?.selector as string).toBe("0xa9059cbb");
  });
});

describe("capability changer comes from the ownership proof", () => {
  function analyzeInput(target: string, modelVersion = "0.0.0-synthetic.1") {
    return {
      address: mustOk(Address.parse(target)),
      block: mustOk(BlockNumber.of(24000000)),
      requestId: mustOk(RequestId.parse("123e4567-e89b-12d3-a456-426614174000")),
      deadline: mustOk(Timestamp.of(1700000005000)),
      modelVersion: mustOk(ModelVersion.parse(modelVersion)),
      indexVersion: mustOk(IndexVersion.parse("1.0.0")),
      templateVersion: mustOk(TemplateVersion.parse("1.0.0")),
      catalogue: TEST_CATALOGUE,
    };
  }

  test("ownerless code carries changerless temporality, never the analysed address", async () => {
    const target = syntheticAddress(21);
    const bytecodeHex = "0x8063a9059cbb14600a575bff00";
    const block = mustOk(BlockNumber.of(24000000));
    const rpc = new FakeRpcAdapter(new Map([[target, bytecodeHex]]), block);
    const services = createAppServices(
      {
        rpc,
        modelArtifacts: new FileModelArtifactAdapter(join(repoRoot, "model")),
        clock: new FakeClockAdapter(mustOk(Timestamp.of(1700000000000))),
      },
      mustDefaultDetectorSet(),
    );
    const analysed = await services.analyzeToken(analyzeInput(target));
    expect(analysed.ok).toBe(true);
    if (!analysed.ok || analysed.value.kind !== "assessed") {
      throw new Error("expected an assessed envelope");
    }
    const capabilities = analysed.value.envelope.signals.filter((signal) => signal.kind === "capability");
    expect(capabilities.length).toBeGreaterThan(0);
    for (const signal of capabilities) {
      if (signal.kind !== "capability") {
        continue;
      }
      expect(signal.temporality.kind).toBe("can-change-unknown");
    }
  });

  test("guarded code names the live owner as changer, not the analysed address", async () => {
    const target = syntheticAddress(22);
    const owner = syntheticAddress(23);
    const bytecode = tokenBytecode([
      { selector: "0x40c10f19", body: [...ownerGuard(0, 200), ...sstoreConstSlot(9, [CALLDATALOAD]), STOP] },
      { selector: "0xa9059cbb", body: [CALLDATALOAD, CALL, STOP] },
    ]);
    const hex = `0x${Buffer.from(bytecode).toString("hex")}`;
    const block = mustOk(BlockNumber.of(24000000));
    const ownerWord = `0x${"0".repeat(24)}${owner.slice(2).toLowerCase()}`;
    const zeroSlot = `0x${"0".repeat(64)}`;
    const rpc = new FakeRpcAdapter(
      new Map([[target, hex]]),
      block,
      new Map([[target, new Map([[zeroSlot, ownerWord]])]]),
    );
    const artifact = mustOk(
      parseModelArtifact({
        version: "0.1.0-prior.test",
        severityWeights: { low: 0.2, medium: 0.5, high: 1.0 },
        causeWeights: { timeout: 0.4, "resource-limit": 0.4, "decompiler-error": 0.6, "obfuscated-structure": 0.6 },
        biases: { "rug-pull": 0.0, honeypot: 0.0, "bot-pump": 0.0 },
        calibration: {
          "rug-pull": { slope: 1.0, intercept: 0.0 },
          honeypot: { slope: 1.0, intercept: 0.0 },
          "bot-pump": { slope: 1.0, intercept: 0.0 },
        },
        scoreWeights: { "rug-pull": 1.0, honeypot: 1.0, "bot-pump": 1.0 },
        pluginWeights: { "dev.brandklipparen.ownership": 0.9 },
        pluginFeatureCatalogue: {
          "dev.brandklipparen.ownership": { risk: "rug-pull", direction: "raises", severity: "high" },
        },
      }),
    );
    const services = createAppServices(
      {
        rpc,
        modelArtifacts: new FakeModelArtifactAdapter(
          Object.freeze({ artifact, checksum: mustOk(ArtifactChecksum.parse("cd".repeat(32))) }),
        ),
        clock: new FakeClockAdapter(mustOk(Timestamp.of(1700000000000))),
      },
      mustDefaultDetectorSet(),
    );
    const analysed = await services.analyzeToken(analyzeInput(target, "0.1.0-prior.test"));
    expect(analysed.ok).toBe(true);
    if (!analysed.ok || analysed.value.kind !== "assessed") {
      throw new Error("expected an assessed envelope");
    }
    const capabilities = analysed.value.envelope.signals.filter((signal) => signal.kind === "capability");
    expect(capabilities.length).toBeGreaterThan(0);
    let sawOwnerChanger = false;
    for (const signal of capabilities) {
      if (signal.kind !== "capability") {
        continue;
      }
      if (signal.temporality.kind === "can-change") {
        expect((signal.temporality.changer as string).toLowerCase()).not.toBe(target.toLowerCase());
        if ((signal.temporality.changer as string).toLowerCase() === owner.toLowerCase()) {
          sawOwnerChanger = true;
        }
      }
    }
    expect(sawOwnerChanger).toBe(true);
  });
});
