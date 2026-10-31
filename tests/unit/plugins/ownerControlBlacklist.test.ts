// Tests for S-115 (K-009, K-010): the blacklist detector plugin
// `dev.brandklipparen.blacklist`. Written first (red) per A-21. The
// shared detector contract proves determinism, schema agreement, evidence
// presence and unchanged inputs; the tests below prove the behaviour: a
// mapping read that gates the transfer path with a revert, paired with a
// privileged mapping write, reports one finding, while an ungated mapping
// read or a privileged write with no transfer gate stays silent.
import { describe, expect, test } from "vitest";
import { Bytecode, CodeHash } from "../../../src/domain/types.ts";
import type { DetectorInput } from "../../../src/plugins/detector.ts";
import { validatePluginOutput } from "../../../src/plugins/detector.ts";
import type { Result } from "../../../src/domain/result.ts";
import { blacklistDetectorPlugin } from "../../../src/plugins/detectors/blacklist/index.ts";
import { runDetectorPluginContract } from "../../contract/detector.contract.ts";
import {
  ADD_LIST_SET,
  CALLDATALOAD,
  ISZERO,
  KECCAK,
  REVERT,
  SHARED_BLACKLIST_SET,
  SLOAD,
  SSTORE,
  STOP,
  TRANSFER_FROM_SELECTOR,
  ownerGuard,
  push1,
  sharedBaseGateTokenHex,
  sharedBlacklistTokenHex,
  tokenBytecode,
  branchOk,
  unprivilegedForeignGateToken,
} from "../../helpers/ownerControlFixtures.ts";

function mustOk<T, E extends { message: string }>(result: Result<T, E>): T {
  if (!result.ok) {
    throw new Error(`expected ok, got error: ${result.error.message}`);
  }
  return result.value;
}

const SET_STATUS = "0x0a9c6c1e";
const TRANSFER = "0xa9059cbb";

function gatedTransferBody(): number[] {
  // Transfer path reads a mapping entry and reverts when it is set.
  return [
    CALLDATALOAD,
    ...push1(3),
    KECCAK,
    SLOAD,
    ISZERO,
    ...branchOk(),
    ...push1(0),
    0x80,
    REVERT,
    0x5b,
    ...push1(2),
    SSTORE,
    STOP,
  ];
}

function setterBody(): number[] {
  // Privileged mapping write to the same hashed slot family.
  return [
    ...ownerGuard(0, 200),
    CALLDATALOAD,
    ...push1(1),
    ...push1(3),
    KECCAK,
    SSTORE,
    STOP,
  ];
}

function makeInput(): DetectorInput {
  const bytecode = tokenBytecode([
    { selector: SET_STATUS, body: setterBody() },
    { selector: TRANSFER, body: gatedTransferBody() },
  ]);
  return Object.freeze({ bytecode, codeHash: mustOk(CodeHash.of(bytecode)) });
}

runDetectorPluginContract("dev.brandklipparen.blacklist", blacklistDetectorPlugin, makeInput);

describe("blacklist detector plugin", () => {
  test("gated mapping read with a privileged writer reports one finding", () => {
    const findings = blacklistDetectorPlugin.detect(makeInput());
    expect(findings).toHaveLength(1);
    const finding = findings[0];
    if (finding === undefined) {
      throw new Error("expected exactly one finding");
    }
    expect(finding.id).toBe("dev.brandklipparen.blacklist:blacklist");
    expect(finding.payload).toEqual({ feature: "blacklist" });
    const selectors = finding.evidence.map((entry) => entry.selector as string).sort();
    expect(selectors).toEqual([SET_STATUS, TRANSFER].sort());
    for (const entry of finding.evidence) {
      expect(typeof entry.offset).toBe("number");
    }
  });

  test("ungated mapping read stays silent", () => {
    // Mapping read with no revert gate: no block is proven.
    const bytecode = tokenBytecode([
      { selector: SET_STATUS, body: setterBody() },
      {
        selector: TRANSFER,
        body: [CALLDATALOAD, ...push1(3), KECCAK, SLOAD, ...push1(2), SSTORE, STOP],
      },
    ]);
    const input: DetectorInput = Object.freeze({ bytecode, codeHash: mustOk(CodeHash.of(bytecode)) });
    expect(blacklistDetectorPlugin.detect(input)).toEqual([]);
  });

  test("gated read with no privileged writer stays silent", () => {
    const bytecode = tokenBytecode([
      {
        selector: SET_STATUS,
        body: [CALLDATALOAD, ...push1(1), ...push1(3), KECCAK, SSTORE, STOP],
      },
      { selector: TRANSFER, body: gatedTransferBody() },
    ]);
    const input: DetectorInput = Object.freeze({ bytecode, codeHash: mustOk(CodeHash.of(bytecode)) });
    expect(blacklistDetectorPlugin.detect(input)).toEqual([]);
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
    expect(blacklistDetectorPlugin.detect(input)).toEqual([]);
  });
});

describe("blacklist extended analysis (P-11)", () => {
  function sharedInput(): DetectorInput {
    const parsed = Bytecode.parse(sharedBlacklistTokenHex());
    if (!parsed.ok) {
      throw new Error("fixture bytecode must parse");
    }
    return Object.freeze({ bytecode: parsed.value, codeHash: mustOk(CodeHash.of(parsed.value)) });
  }

  test("shared transfer gate with a privileged writer reports an extended fact, never a feature", () => {
    // The gate lives in the shared helper, so the v1 proof stays silent
    // and only the v2 reachability view proves the pair. Both transfer
    // entries reach the same gate; the first in selector order wins.
    const findings = blacklistDetectorPlugin.detect(sharedInput());
    expect(findings).toHaveLength(1);
    const finding = findings[0];
    if (finding === undefined) {
      throw new Error("expected exactly one finding");
    }
    expect(finding.id).toBe("dev.brandklipparen.blacklist:blacklist-extended");
    expect(finding.payload).toEqual({ fact: "blacklist", proof: "extended" });
    const selectors = finding.evidence.map((entry) => entry.selector as string).sort();
    expect(selectors).toEqual([SHARED_BLACKLIST_SET, TRANSFER_FROM_SELECTOR].sort());
    for (const entry of finding.evidence) {
      expect(typeof entry.offset).toBe("number");
    }
  });

  test("extended fact payload validates against the manifest output schema", () => {
    const findings = blacklistDetectorPlugin.detect(sharedInput());
    const plain = JSON.parse(JSON.stringify(findings)) as unknown;
    expect(validatePluginOutput(plain, blacklistDetectorPlugin.manifest.outputSchema)).toBe(true);
  });
});

describe("blacklist extended precision (P-11 follow-up)", () => {
  function sharedConfigInput(config: {
    writerSelector: string;
    guarded: boolean;
    writeBase: number;
    gateBase: number;
  }): DetectorInput {
    const parsed = Bytecode.parse(sharedBaseGateTokenHex(config));
    if (!parsed.ok) {
      throw new Error("fixture bytecode must parse");
    }
    return Object.freeze({ bytecode: parsed.value, codeHash: mustOk(CodeHash.of(parsed.value)) });
  }

  test("unprivileged balance write with a gate on another mapping stays silent", () => {
    // The balance writer carries no caller check against the owner slot
    // even though an owner setter proves the slot elsewhere, so no
    // privileged writer exists for the gated mapping.
    const bytecode = unprivilegedForeignGateToken();
    const input: DetectorInput = Object.freeze({ bytecode, codeHash: mustOk(CodeHash.of(bytecode)) });
    expect(blacklistDetectorPlugin.detect(input)).toEqual([]);
  });

  test("approve as the only writer stays silent", () => {
    // A guarded `approve` writes the gated mapping, but standard token
    // entries can never prove a privileged writer.
    const input = sharedConfigInput({
      writerSelector: "0x095ea7b3",
      guarded: true,
      writeBase: 9,
      gateBase: 9,
    });
    expect(blacklistDetectorPlugin.detect(input)).toEqual([]);
  });

  test("privileged list setter with the gate on the same base reports a fact", () => {
    // The guarded list setter writes mapping base 7 and the shared gate
    // reads base 7, so the pair proves one list with that writer.
    const input = sharedConfigInput({
      writerSelector: ADD_LIST_SET,
      guarded: true,
      writeBase: 7,
      gateBase: 7,
    });
    const findings = blacklistDetectorPlugin.detect(input);
    expect(findings).toHaveLength(1);
    const finding = findings[0];
    if (finding === undefined) {
      throw new Error("expected exactly one finding");
    }
    expect(finding.id).toBe("dev.brandklipparen.blacklist:blacklist-extended");
    expect(finding.payload).toEqual({ fact: "blacklist", proof: "extended" });
    expect(finding.evidence[0]?.selector).toBe(ADD_LIST_SET);
    const selectors = finding.evidence.map((entry) => entry.selector as string).sort();
    expect(selectors).toEqual([ADD_LIST_SET, TRANSFER_FROM_SELECTOR].sort());
  });

  test("privileged writer with the gate on another base stays silent", () => {
    // The guarded setter writes base 7 while the shared gate reads base
    // 8: different mappings, so no pair is proven.
    const input = sharedConfigInput({
      writerSelector: ADD_LIST_SET,
      guarded: true,
      writeBase: 7,
      gateBase: 8,
    });
    expect(blacklistDetectorPlugin.detect(input)).toEqual([]);
  });
});
