// Step 0 recall tests (S-115 follow-up): generic solc-optimised patterns.
// Every case below is synthetic hand-assembled bytecode, no real tokens.
// Written first (red): the shared analysis is too strict on real code
// (spurious slot resolution, distinct-region proofs, pause LT/GT veto
// and sell-block over-firing), so these generic shapes stay silent or
// fire wrongly until the fix lands.
import { describe, expect, test } from "vitest";
import { Bytecode, CodeHash } from "../../../src/domain/types.ts";
import type { DetectorInput } from "../../../src/plugins/detector.ts";
import type { Result } from "../../../src/domain/result.ts";
import { mintDetectorPlugin } from "../../../src/plugins/detectors/mint/index.ts";
import { pauseDetectorPlugin } from "../../../src/plugins/detectors/pause/index.ts";
import { transferFeeDetectorPlugin } from "../../../src/plugins/detectors/transfer-fee/index.ts";
import { transferLimitsDetectorPlugin } from "../../../src/plugins/detectors/transfer-limits/index.ts";
import { blacklistDetectorPlugin } from "../../../src/plugins/detectors/blacklist/index.ts";
import { sellBlockDetectorPlugin } from "../../../src/plugins/detectors/sell-block/index.ts";
import { analyzeOwnerControl } from "../../../src/domain/ownerControl.ts";
import {
  CALLDATALOAD,
  EQ,
  ISZERO,
  JUMPI,
  KECCAK,
  MUL,
  LT,
  PUSH0,
  REVERT,
  SLOAD,
  SSTORE,
  STOP,
  ADD,
  SUB,
  ownerGuard,
  push1,
  sstoreConstSlot,
  tokenBytecode,
} from "../../helpers/ownerControlFixtures.ts";

function mustOk<T, E extends { message: string }>(result: Result<T, E>): T {
  if (!result.ok) {
    throw new Error(`expected ok, got error: ${result.error.message}`);
  }
  return result.value;
}

function toInput(bytecode: ReturnType<typeof tokenBytecode>): DetectorInput {
  return Object.freeze({ bytecode, codeHash: mustOk(CodeHash.of(bytecode)) });
}

const TRANSFER = "0xa9059cbb";
const SETTER = "0x0a9c6c1e";

describe("step 0 recall: merged privileged transfer proves mint", () => {
  test("single guarded transfer that grows supply reports mint", () => {
    // Generic OZ-style mint merged into one function: onlyOwner guard,
    // supply slot 1 grows with ADD, balances mapping written. The proof
    // must not require two distinct functions.
    const bytecode = tokenBytecode([
      {
        selector: TRANSFER,
        body: [
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
        ],
      },
    ]);
    const findings = mintDetectorPlugin.detect(toInput(bytecode));
    expect(findings).toHaveLength(1);
    expect(findings[0]?.payload).toEqual({ feature: "mint", slot: 1 });
  });
});

describe("step 0 recall: pausable transfer with other compares", () => {
  test("pause gate fires even when the transfer also bounds with LT", () => {
    // Generic Pausable whenNotPaused: flag slot 4 gates the path with
    // EQ/ISZERO plus revert, while an unrelated amount check uses LT.
    // The LT elsewhere must not veto the boolean flag proof.
    const bytecode = tokenBytecode([
      {
        selector: SETTER,
        body: [...ownerGuard(0, 200), ...sstoreConstSlot(4, [...push1(1)]), STOP],
      },
      {
        selector: TRANSFER,
        body: [
          ...push1(4),
          SLOAD,
          ISZERO,
          ...push1(90),
          JUMPI,
          ...push1(0),
          0x80,
          REVERT,
          0x5b,
          CALLDATALOAD,
          ...push1(6),
          SLOAD,
          LT,
          ...push1(100),
          JUMPI,
          ...sstoreConstSlot(2, [CALLDATALOAD]),
          STOP,
        ],
      },
    ]);
    const findings = pauseDetectorPlugin.detect(toInput(bytecode));
    expect(findings).toHaveLength(1);
    expect(findings[0]?.payload).toEqual({ feature: "pause", slot: 4, mode: "trading-toggle" });
  });
});

describe("step 0 recall: fee in merged transfer", () => {
  test("guarded fee slot used arithmetically in the same function reports fee", () => {
    const bytecode = tokenBytecode([
      {
        selector: TRANSFER,
        body: [
          ...ownerGuard(0, 200),
          ...sstoreConstSlot(5, [CALLDATALOAD]),
          CALLDATALOAD,
          ...push1(5),
          SLOAD,
          MUL,
          SUB,
          ...sstoreConstSlot(2, [CALLDATALOAD]),
          STOP,
        ],
      },
    ]);
    const findings = transferFeeDetectorPlugin.detect(toInput(bytecode));
    expect(findings).toHaveLength(1);
    expect(findings[0]?.payload).toEqual({ feature: "transfer-fee", slot: 5, maxFeeBasisPoints: null });
  });
});

describe("step 0 recall: limits in merged transfer", () => {
  test("guarded limit compared in the same function reports max-tx", () => {
    const bytecode = tokenBytecode([
      {
        selector: TRANSFER,
        body: [
          ...ownerGuard(0, 200),
          ...sstoreConstSlot(6, [CALLDATALOAD]),
          CALLDATALOAD,
          ...push1(6),
          SLOAD,
          LT,
          ISZERO,
          ...push1(90),
          JUMPI,
          ...push1(0),
          0x80,
          REVERT,
          0x5b,
          ...sstoreConstSlot(2, [CALLDATALOAD]),
          STOP,
        ],
      },
    ]);
    const findings = transferLimitsDetectorPlugin.detect(toInput(bytecode));
    expect(findings).toHaveLength(1);
    expect(findings[0]?.payload).toEqual({ feature: "transfer-limits", slot: 6, limitKind: "max-tx" });
  });
});

describe("step 0 recall: blacklist in merged transfer", () => {
  test("guarded mapping write gating the same function reports blacklist", () => {
    const bytecode = tokenBytecode([
      {
        selector: TRANSFER,
        body: [
          ...ownerGuard(0, 200),
          CALLDATALOAD,
          ...push1(1),
          ...push1(3),
          KECCAK,
          SSTORE,
          CALLDATALOAD,
          ...push1(3),
          KECCAK,
          SLOAD,
          ISZERO,
          ...push1(90),
          JUMPI,
          ...push1(0),
          0x80,
          REVERT,
          0x5b,
          ...push1(2),
          SSTORE,
          STOP,
        ],
      },
    ]);
    const findings = blacklistDetectorPlugin.detect(toInput(bytecode));
    expect(findings).toHaveLength(1);
    expect(findings[0]?.payload).toEqual({ feature: "blacklist" });
  });
});

describe("step 0 recall: sell-block precision", () => {
  test("standard balance-check transfer with only mapping reads stays silent", () => {
    // Generic standard transfer: balances mapping read with EQ/ISZERO
    // plus revert for the zero-amount check, no stored pair address.
    // Must NOT be flagged as sell-block.
    const bytecode = tokenBytecode([
      {
        selector: TRANSFER,
        body: [
          CALLDATALOAD,
          ...push1(2),
          KECCAK,
          SLOAD,
          CALLDATALOAD,
          EQ,
          ISZERO,
          ...push1(60),
          JUMPI,
          ...push1(0),
          0x80,
          REVERT,
          0x5b,
          ...sstoreConstSlot(2, [CALLDATALOAD]),
          STOP,
        ],
      },
    ]);
    expect(sellBlockDetectorPlugin.detect(toInput(bytecode))).toEqual([]);
  });

  test("pair-gated sell branch with const plus mapping still reports", () => {
    const bytecode = tokenBytecode([
      {
        selector: SETTER,
        body: [...ownerGuard(0, 200), ...sstoreConstSlot(9, [CALLDATALOAD]), STOP],
      },
      {
        selector: TRANSFER,
        body: [
          CALLDATALOAD,
          ...push1(9),
          SLOAD,
          EQ,
          ISZERO,
          ...push1(90),
          JUMPI,
          ...push1(0),
          0x80,
          REVERT,
          0x5b,
          CALLDATALOAD,
          ...push1(2),
          KECCAK,
          SLOAD,
          ...sstoreConstSlot(2, [CALLDATALOAD]),
          STOP,
        ],
      },
    ]);
    const findings = sellBlockDetectorPlugin.detect(toInput(bytecode));
    expect(findings).toHaveLength(1);
    expect(findings[0]?.payload).toEqual({ feature: "sell-block", condition: "pair-mapping" });
  });
});

describe("step 0 recall: slot resolution stays conservative", () => {
  test("distant PUSH does not resolve to a const slot", () => {
    // PUSH 42 far before SLOAD with other ops in between must stay
    // unknown, not a const 42 load. Adjacent PUSH still resolves.
    const adjacent = tokenBytecode([
      {
        selector: TRANSFER,
        body: [CALLDATALOAD, ...push1(7), SLOAD, ...sstoreConstSlot(2, [CALLDATALOAD]), STOP],
      },
    ]);
    const parsed = Bytecode.parse(
      `0x${Buffer.from(adjacent).toString("hex")}`,
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) {
      throw new Error("fixture must parse");
    }
    const view = analyzeOwnerControl(parsed.value);
    const region = view.regions.find((entry) => (entry.selector as string) === TRANSFER);
    expect(region).toBeDefined();
    expect(region?.loads.some((load) => load.slot.kind === "const" && load.slot.value === 7)).toBe(true);

    // Near but not adjacent: PUSH 42, then a few unrelated ops, then
    // SLOAD with no adjacent slot push. The load must not claim slot 42.
    // The old 12-slot lookback guessed such cases; the fix keeps only
    // adjacent slot pushes.
    const distantBody: number[] = [
      ...push1(42),
      CALLDATALOAD,
      CALLDATALOAD,
      ADD,
      ADD,
      ADD,
      SLOAD,
      ...sstoreConstSlot(2, [CALLDATALOAD]),
      STOP,
    ];
    const distant = tokenBytecode([{ selector: TRANSFER, body: distantBody }]);
    const parsedDistant = Bytecode.parse(`0x${Buffer.from(distant).toString("hex")}`);
    expect(parsedDistant.ok).toBe(true);
    if (!parsedDistant.ok) {
      throw new Error("fixture must parse");
    }
    const distantView = analyzeOwnerControl(parsedDistant.value);
    const distantRegion = distantView.regions.find((entry) => (entry.selector as string) === TRANSFER);
    expect(distantRegion).toBeDefined();
    expect(
      distantRegion?.loads.some((load) => load.slot.kind === "const" && load.slot.value === 42),
    ).toBe(false);
  });
});

describe("step 0 recall: zero owner word stays can't-tell", () => {
  test("offline zero word keeps can-change instead of applies-now", async () => {
    const { Address, BlockNumber, IndexVersion, ModelVersion, RequestId, TemplateVersion, Timestamp } =
      await import("../../../src/domain/types.ts");
    const { FakeRpcAdapter } = await import("../../fakes/fakeRpc.ts");
    const { FakeClockAdapter } = await import("../../fakes/fakeClock.ts");
    const { FakeModelArtifactAdapter } = await import("../../fakes/fakeModelArtifact.ts");
    const { parseModelArtifact } = await import("../../../src/domain/risk.ts");
    const { ArtifactChecksum } = await import("../../../src/domain/types.ts");
    const { createAppServices } = await import("../../../src/application/analyzeToken.ts");
    const { mustDefaultDetectorSet } = await import("../../helpers/detectorSets.ts");
    const SET_ADMIN = "0x40c10f19";
    const bytecode = tokenBytecode([
      {
        selector: SET_ADMIN,
        body: [...ownerGuard(0, 200), ...sstoreConstSlot(9, [CALLDATALOAD]), STOP],
      },
      {
        selector: TRANSFER,
        body: [PUSH0, CALLDATALOAD, ...push1(0), SSTORE, STOP],
      },
    ]);
    const target = mustOk(Address.parse("0x0102030405060708090a0b0c0d0e0f1011121314"));
    const block = mustOk(BlockNumber.of(24000000));
    const hex = `0x${Buffer.from(bytecode).toString("hex")}`;
    const rpc = new FakeRpcAdapter(new Map([[target as string, hex]]), block);
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
    const analysed = await services.analyzeToken({
      address: target,
      block,
      requestId: mustOk(RequestId.parse("123e4567-e89b-12d3-a456-426614174000")),
      deadline: mustOk(Timestamp.of(1700000005000)),
      modelVersion: mustOk(ModelVersion.parse("0.1.0-prior.test")),
      indexVersion: mustOk(IndexVersion.parse("1.0.0")),
      templateVersion: mustOk(TemplateVersion.parse("1.0.0")),
      catalogue: {
        selfdestruct: { risk: "rug-pull", direction: "raises", severity: "high" },
        delegatecall: { risk: "rug-pull", direction: "raises", severity: "high" },
        call: { risk: "honeypot", direction: "raises", severity: "medium" },
        "storage-write": { risk: "bot-pump", direction: "raises", severity: "low" },
      },
    });
    expect(analysed.ok).toBe(true);
    if (!analysed.ok || analysed.value.kind !== "assessed") {
      throw new Error("expected an assessed envelope");
    }
    const ownerSignals = analysed.value.envelope.signals.filter(
      (signal) =>
        signal.kind === "capability" && signal.risk === "rug-pull" && signal.severity === "high",
    );
    expect(ownerSignals.length).toBeGreaterThan(0);
    for (const signal of ownerSignals) {
      if (signal.kind !== "capability") {
        continue;
      }
      expect(signal.temporality.kind).toBe("can-change");
    }
  });
});
