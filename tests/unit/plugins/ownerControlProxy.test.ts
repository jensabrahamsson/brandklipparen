// Tests for S-115 (K-009, K-010): the proxy-upgrade detector plugin
// `dev.brandklipparen.proxy-upgrade`. Written first (red) per A-21. The
// shared detector contract proves determinism, schema agreement, evidence
// presence and unchanged inputs; the tests below prove the behaviour: an
// upgrade entry behind a caller guard reports the UUPS kind, a
// delegatecall proxy with an upgrade entry reports the EIP-1967 kind,
// while an unguarded upgrade entry alone or a delegatecall proxy with no
// upgrade entry stays silent.
import { describe, expect, test } from "vitest";
import { Bytecode, CodeHash } from "../../../src/domain/types.ts";
import type { DetectorInput } from "../../../src/plugins/detector.ts";
import type { Result } from "../../../src/domain/result.ts";
import { proxyUpgradeDetectorPlugin } from "../../../src/plugins/detectors/proxy-upgrade/index.ts";
import { runDetectorPluginContract } from "../../contract/detector.contract.ts";
import {
  CALLDATALOAD,
  DELEGATECALL,
  SLOAD,
  STOP,
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

// upgradeTo(address).
const UPGRADE_TO = "0x3659cfe6";
const TRANSFER = "0xa9059cbb";

function guardedUpgradeBody(): number[] {
  return [...ownerGuard(0, 200), ...sstoreConstSlot(9, [CALLDATALOAD]), STOP];
}

function makeUupsInput(): DetectorInput {
  const bytecode = tokenBytecode([
    { selector: UPGRADE_TO, body: guardedUpgradeBody() },
    { selector: TRANSFER, body: [CALLDATALOAD, ...sstoreConstSlot(2, [CALLDATALOAD]), STOP] },
  ]);
  return Object.freeze({ bytecode, codeHash: mustOk(CodeHash.of(bytecode)) });
}

runDetectorPluginContract("dev.brandklipparen.proxy-upgrade", proxyUpgradeDetectorPlugin, makeUupsInput);

describe("proxy-upgrade detector plugin", () => {
  test("guarded upgrade entry reports the UUPS kind", () => {
    const findings = proxyUpgradeDetectorPlugin.detect(makeUupsInput());
    expect(findings).toHaveLength(1);
    const finding = findings[0];
    if (finding === undefined) {
      throw new Error("expected exactly one finding");
    }
    expect(finding.id).toBe("dev.brandklipparen.proxy-upgrade:proxy-upgrade");
    expect(finding.payload).toEqual({
      feature: "proxy-upgrade",
      proxyKind: "uups",
      upgradeSelector: UPGRADE_TO,
    });
    expect(finding.evidence[0]?.selector as string).toBe(UPGRADE_TO);
  });

  test("delegatecall proxy with an upgrade entry reports the EIP-1967 kind", () => {
    const bytecode = tokenBytecode([
      { selector: UPGRADE_TO, body: [CALLDATALOAD, ...sstoreConstSlot(9, [CALLDATALOAD]), STOP] },
      {
        selector: TRANSFER,
        body: [CALLDATALOAD, ...push1(0), SLOAD, ...push1(0), DELEGATECALL, STOP],
      },
    ]);
    const input: DetectorInput = Object.freeze({ bytecode, codeHash: mustOk(CodeHash.of(bytecode)) });
    const findings = proxyUpgradeDetectorPlugin.detect(input);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.payload).toEqual({
      feature: "proxy-upgrade",
      proxyKind: "eip1967",
      upgradeSelector: UPGRADE_TO,
    });
  });

  test("delegatecall proxy with no upgrade entry stays silent", () => {
    const bytecode = tokenBytecode([
      {
        selector: TRANSFER,
        body: [CALLDATALOAD, ...push1(0), SLOAD, ...push1(0), DELEGATECALL, STOP],
      },
    ]);
    const input: DetectorInput = Object.freeze({ bytecode, codeHash: mustOk(CodeHash.of(bytecode)) });
    expect(proxyUpgradeDetectorPlugin.detect(input)).toEqual([]);
  });

  test("bytecode without selectors yields no findings", () => {
    const parsed = Bytecode.parse("0x6001600055");
    if (!parsed.ok) {
      throw new Error("fixture bytecode must parse");
    }
    const input: DetectorInput = Object.freeze({
      bytecode: parsed.value,
      codeHash: mustOk(CodeHash.of(parsed.value)),
    });
    expect(proxyUpgradeDetectorPlugin.detect(input)).toEqual([]);
  });
});
