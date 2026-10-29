// Part B regression tests: WETH-shaped dispatcher attribution.
// A classic wrapped-ether layout (Solidity 0.4-style linear dispatcher:
// PUSH4 selector, EQ, PUSH2 dest, JUMPI chain; payable fallback; a
// withdraw function that sends ether to msg.sender) once produced four
// capability signals whose evidence was ALL attributed to the selector of
// allowance(address,address) (0xdd62ed3e, the last dispatcher entry) at
// many offsets spread across the code, yielding false claims ("lets an
// account block a withdrawal", "favor one trade over another") and
// decompiled lines reading "Unresolved_dd62ed3e()".
//
// Every fixture below is hand-assembled from opcode numbers: no real
// contract bytecode, no addresses, no external data. The dispatcher holds
// five paired entries (deposit, withdraw, transfer, approve, allowance
// last) and every body opens with JUMPDEST. Transfer and approve end with
// an internal PUSH2/JUMP into one shared tail placed AFTER the allowance
// body; the tail carries its own SSTORE and CALL. The old positional rule
// ("greatest entry target at or below the PC") attributed the whole tail
// to allowance, the last entry. Honest attribution follows control flow:
// the tail is reachable from two entries, so it belongs to neither.
import { describe, expect, test } from "vitest";
import { Address, BlockNumber, Bytecode, CodeHash, IndexVersion, ModelVersion, RequestId, TemplateVersion, Timestamp } from "../../../src/domain/types.ts";
import type { Result } from "../../../src/domain/result.ts";
import { detectCapabilities } from "../../../src/domain/signals.ts";
import type { CapabilityCatalogue } from "../../../src/domain/signals.ts";
import { analyzeOwnerControl } from "../../../src/domain/ownerControl.ts";
import { capabilityDetectorPlugin } from "../../../src/plugins/detectors/capability/index.ts";
import { transferHooksDetectorPlugin } from "../../../src/plugins/detectors/transfer-hooks/index.ts";
import type { DetectorInput } from "../../../src/plugins/detector.ts";
import { createAppServices } from "../../../src/application/analyzeToken.ts";
import { FakeClockAdapter } from "../../fakes/fakeClock.ts";
import { FakeModelArtifactAdapter } from "../../fakes/fakeModelArtifact.ts";
import { FakeRpcAdapter } from "../../fakes/fakeRpc.ts";
import { parseModelArtifact } from "../../../src/domain/risk.ts";
import { ArtifactChecksum } from "../../../src/domain/types.ts";
import { mustDefaultDetectorSet } from "../../helpers/detectorSets.ts";
import { syntheticAddress } from "../../helpers/syntheticAddresses.ts";

function mustOk<T, E extends { message: string }>(result: Result<T, E>): T {
  if (!result.ok) {
    throw new Error(`expected ok, got error: ${result.error.message}`);
  }
  return result.value;
}

const DEPOSIT = "0xd0e30db0";
const WITHDRAW = "0x2e1a7d4d";
const TRANSFER = "0xa9059cbb";
const APPROVE = "0x095ea7b3";
const ALLOWANCE = "0xdd62ed3e";

function selectorBytes(selector: string): number[] {
  const body = selector.slice(2);
  const out: number[] = [];
  for (let i = 0; i < 8; i += 2) {
    out.push(Number.parseInt(body.slice(i, i + 2), 16));
  }
  return out;
}

// Hand-assembled WETH-shaped runtime: linear dispatcher, STOP fallback,
// five bodies, one shared tail after the allowance body. Transfer and
// approve reach the tail through an internal PUSH2/JUMP; nothing else
// does. Returns the bytecode with every destination resolved.
function wethShapedBytecode(): Bytecode {
  // Dispatcher windows first; destinations resolve once bodies lay out.
  const order = [DEPOSIT, WITHDRAW, TRANSFER, APPROVE, ALLOWANCE];
  const bodies = new Map<string, number[]>([
    [
      DEPOSIT,
      // Deposit: balance-style read plus a slot-1 write, then stop.
      [0x5b, 0x35, 0x60, 0x01, 0x54, 0x60, 0x0a, 0x60, 0x01, 0x55, 0x00],
    ],
    [
      WITHDRAW,
      // Withdraw: slot-3 balance update, then a CALL that pays out to
      // msg.sender (CALLER directly in the target window).
      [
        0x5b, 0x60, 0x03, 0x54, 0x60, 0x00, 0x60, 0x03, 0x55, 0x35, 0x33, 0x60, 0x00, 0x60, 0x00,
        0x60, 0x00, 0x60, 0x00, 0x60, 0x00, 0x60, 0x00, 0xf1, 0x00,
      ],
    ],
    [
      TRANSFER,
      // Transfer-shaped traffic that jumps into the shared tail.
      [0x5b, 0x35, 0x60, 0x07, 0x54, 0x60, 0x09, 0x60, 0x07, 0x55, 0x61, 0x00, 0x00, 0x56],
    ],
    [
      APPROVE,
      // Allowance write that jumps into the shared tail.
      [0x5b, 0x35, 0x60, 0x02, 0x60, 0x02, 0x55, 0x61, 0x00, 0x00, 0x56],
    ],
    [
      ALLOWANCE,
      // The getter: mapping-style reads and a return, no writes or calls.
      [0x5b, 0x35, 0x60, 0x0b, 0x54, 0x60, 0x0c, 0x54, 0x60, 0x00, 0x60, 0x00, 0xf3],
    ],
  ]);
  // Tail placeholder: patched with the real tail address below.
  const tail: number[] = [
    0x5b, 0x60, 0x01, 0x60, 0x09, 0x55, 0x60, 0x00, 0x60, 0x00, 0x60, 0x00,
    0x60, 0x00, 0x60, 0x00, 0x60, 0x00, 0xf1, 0x00,
  ];
  // Layout: dispatcher, fallback STOP, bodies in dispatcher order, tail.
  let pc = order.length * 11 + 1;
  const targets = new Map<string, number>();
  for (const selector of order) {
    targets.set(selector, pc);
    pc += (bodies.get(selector) ?? []).length + 1;
  }
  const tailPc = pc;
  // Patch the internal jumps to the shared tail.
  for (const selector of [TRANSFER, APPROVE]) {
    const body = bodies.get(selector);
    if (body === undefined) {
      throw new Error(`missing body for ${selector}`);
    }
    body[body.length - 3] = (tailPc >> 8) & 0xff;
    body[body.length - 2] = tailPc & 0xff;
  }
  const out: number[] = [];
  for (const selector of order) {
    const target = targets.get(selector) ?? 0;
    out.push(0x80, 0x63, ...selectorBytes(selector), 0x14, 0x61, (target >> 8) & 0xff, target & 0xff, 0x57);
  }
  out.push(0x00);
  for (const selector of order) {
    const body = bodies.get(selector);
    if (body === undefined) {
      throw new Error(`missing body for ${selector}`);
    }
    out.push(...body, 0x00);
  }
  // Bodies above end with STOP/JUMP/RETURN, so the padding STOP after
  // each is unreachable dead code the attribution must never cite.
  out.push(...tail);
  const hex = out.map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return mustOk(Bytecode.parse(`0x${hex}`));
}

function toInput(bytecode: Bytecode): DetectorInput {
  return Object.freeze({ bytecode, codeHash: mustOk(CodeHash.of(bytecode)) });
}

const WITHDRAW_CATALOGUE: CapabilityCatalogue = Object.freeze({
  selfdestruct: Object.freeze({ risk: "rug-pull", direction: "raises", severity: "high" }),
  delegatecall: Object.freeze({ risk: "rug-pull", direction: "raises", severity: "high" }),
  call: Object.freeze({ risk: "honeypot", direction: "raises", severity: "medium" }),
  "storage-write": Object.freeze({ risk: "rug-pull", direction: "raises", severity: "low" }),
});

describe("weth-shaped dispatcher attribution", () => {
  test("no capability evidence is attributed to the allowance getter", () => {
    const bytecode = wethShapedBytecode();
    const findings = capabilityDetectorPlugin.detect(toInput(bytecode));
    expect(findings.length).toBeGreaterThan(0);
    for (const finding of findings) {
      for (const entry of finding.evidence) {
        expect(entry.selector as string).not.toBe(ALLOWANCE);
      }
    }
  });

  test("the shared tail keeps its inline writers: storage writes still report their holders", () => {
    const bytecode = wethShapedBytecode();
    const findings = capabilityDetectorPlugin.detect(toInput(bytecode));
    const writes = findings.find((finding) => (finding.payload as { capability?: string }).capability === "storage-write");
    expect(writes).toBeDefined();
    const holders = new Set((writes?.evidence ?? []).map((entry) => entry.selector as string));
    expect(holders.has(DEPOSIT)).toBe(true);
    expect(holders.has(ALLOWANCE)).toBe(false);
  });

  test("a send-to-caller CALL reports no call capability", () => {
    const bytecode = wethShapedBytecode();
    const findings = capabilityDetectorPlugin.detect(toInput(bytecode));
    const calls = findings.find((finding) => (finding.payload as { capability?: string }).capability === "call");
    expect(calls).toBeUndefined();
  });

  test("a send-to-caller CALL reports no transfer hook", () => {
    const bytecode = wethShapedBytecode();
    expect(transferHooksDetectorPlugin.detect(toInput(bytecode))).toEqual([]);
  });

  test("the allowance region carries no calls or stores", () => {
    const bytecode = wethShapedBytecode();
    const view = analyzeOwnerControl(bytecode);
    const allowance = view.regions.find((region) => region.selector === ALLOWANCE);
    expect(allowance).toBeDefined();
    expect(allowance?.calls ?? []).toEqual([]);
    expect(allowance?.stores ?? []).toEqual([]);
  });

  test("no honeypot or bot-pump signal arises from the withdraw payout", () => {
    const bytecode = wethShapedBytecode();
    const signals = detectCapabilities(bytecode, mustOk(CodeHash.of(bytecode)), WITHDRAW_CATALOGUE, {
      kind: "can-change-unknown",
    });
    expect(signals.filter((signal) => signal.kind === "capability" && signal.risk === "honeypot")).toEqual([]);
    expect(signals.filter((signal) => signal.kind === "capability" && signal.risk === "bot-pump")).toEqual([]);
    expect(signals.length).toBeGreaterThan(0);
  });
});

describe("weth-shaped service assessment", () => {
  function analyzeInput(target: string) {
    return {
      address: mustOk(Address.parse(target)),
      block: mustOk(BlockNumber.of(24000000)),
      requestId: mustOk(RequestId.parse("123e4567-e89b-12d3-a456-426614174000")),
      deadline: mustOk(Timestamp.of(1700000005000)),
      modelVersion: mustOk(ModelVersion.parse("0.1.0-prior.test")),
      indexVersion: mustOk(IndexVersion.parse("1.0.0")),
      templateVersion: mustOk(TemplateVersion.parse("1.0.0")),
      catalogue: WITHDRAW_CATALOGUE,
    };
  }

  test("withdraw payout plus shared tail yield no honeypot or bot-pump signal", async () => {
    const target = syntheticAddress(31);
    const bytecode = wethShapedBytecode();
    const hex = `0x${Buffer.from(bytecode).toString("hex")}`;
    const block = mustOk(BlockNumber.of(24000000));
    const rpc = new FakeRpcAdapter(new Map([[target, hex]]), block);
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
        pluginWeights: { "dev.brandklipparen.transfer-hooks": 1.0 },
        pluginFeatureCatalogue: {
          "dev.brandklipparen.transfer-hooks": { risk: "bot-pump", direction: "raises", severity: "medium" },
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
    const analysed = await services.analyzeToken(analyzeInput(target));
    expect(analysed.ok).toBe(true);
    if (!analysed.ok || analysed.value.kind !== "assessed") {
      throw new Error("expected an assessed envelope");
    }
    const risks = analysed.value.envelope.signals.map((signal) => signal.kind === "capability" ? signal.risk : null);
    expect(risks).not.toContain("honeypot");
    expect(risks).not.toContain("bot-pump");
    expect(analysed.value.envelope.signals.length).toBeGreaterThan(0);
  });
});
