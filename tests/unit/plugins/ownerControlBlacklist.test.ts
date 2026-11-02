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
  BALANCE_GATE_SET,
  CALLDATALOAD,
  COMPOUND_SET,
  DUAL_BLACKLIST_SET,
  ISZERO,
  KECCAK,
  MSTORE,
  PACKED_MAPPING_SET,
  REVERT,
  SHARED_BLACKLIST_SET,
  SLOAD,
  SSTORE,
  STOP,
  TRANSFER_FROM_SELECTOR,
  balanceGateTokenHex,
  compoundGuardBlacklistTokenHex,
  dualBlacklistGateTokenHex,
  feeExemptGateTokenHex,
  jumpSideBlacklistTokenHex,
  roleOnlyBlacklistTokenHex,
  scratchOffsetBlacklistTokenHex,
  shuffledStoreBlacklistTokenHex,
  shiftedOwnerBlacklistTokenHex,
  shortCircuitBlacklistTokenHex,
  ownerGuard,
  packedMappingBlacklistToken,
  push1,
  scanRExemptLimitTokenHex,
  scanRSubGuardBlacklistTokenHex,
  scanRSubGuardFeeExemptTokenHex,
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
  // Transfer path reads mapping base 3 through the explicit keccak(key .
  // baseSlot) memory pattern and reverts when the entry is set.
  return [
    CALLDATALOAD,
    ...push1(0),
    MSTORE,
    ...push1(3),
    ...push1(0x20),
    MSTORE,
    ...push1(0x40),
    ...push1(0x00),
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
  // Privileged mapping write to base 3 through the same memory pattern,
  // so the written base matches the gate base.
  return [
    ...ownerGuard(0, 200),
    CALLDATALOAD,
    CALLDATALOAD,
    ...push1(0),
    MSTORE,
    ...push1(3),
    ...push1(0x20),
    MSTORE,
    ...push1(0x40),
    ...push1(0x00),
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

describe("blacklist packed bool-in-mapping (P-11 follow-up)", () => {
  function packedInput(writeBase = 5, gateBase = 5): DetectorInput {
    const bytecode = packedMappingBlacklistToken(writeBase, gateBase);
    return Object.freeze({ bytecode, codeHash: mustOk(CodeHash.of(bytecode)) });
  }

  test("packed bool-in-mapping write from calldata reports an extended fact", () => {
    // The onlyOwner setter stores `OR(AND(SLOAD(keccak), NOT(0xff)), value)`
    // with the bool value from calldata, and the transfer path reverts
    // while packed fields of the same entry read set. The two-field gate
    // spans more than the beside window, so the scored and beside-window
    // proofs stay silent while the extended packed-gate proof pairs the
    // writer with the gate.
    const findings = blacklistDetectorPlugin.detect(packedInput());
    expect(findings).toHaveLength(1);
    const finding = findings[0];
    if (finding === undefined) {
      throw new Error("expected exactly one finding");
    }
    expect(finding.id).toBe("dev.brandklipparen.blacklist:blacklist-extended");
    expect(finding.payload).toEqual({ fact: "blacklist", proof: "extended" });
    const selectors = finding.evidence.map((entry) => entry.selector as string).sort();
    expect(selectors).toEqual([PACKED_MAPPING_SET, TRANSFER].sort());
    for (const entry of finding.evidence) {
      expect(typeof entry.offset).toBe("number");
    }
    const plain = JSON.parse(JSON.stringify(findings)) as unknown;
    expect(validatePluginOutput(plain, blacklistDetectorPlugin.manifest.outputSchema)).toBe(true);
  });

  test("packed write with the gate on another base stays silent", () => {
    // The guarded setter packs base 7 while the packed gate reads base
    // 8: different mappings, so the packed gate never pairs.
    expect(blacklistDetectorPlugin.detect(packedInput(7, 8))).toEqual([]);
  });
});

describe("blacklist scored precision (C-7)", () => {
  function setterOnBase(base: number): number[] {
    // Privileged registry-style write to one mapping base through the
    // explicit keccak(key . baseSlot) memory pattern.
    return [
      ...ownerGuard(0, 200),
      CALLDATALOAD,
      CALLDATALOAD,
      ...push1(0),
      MSTORE,
      ...push1(base),
      ...push1(0x20),
      MSTORE,
      ...push1(0x40),
      ...push1(0x00),
      KECCAK,
      SSTORE,
      STOP,
    ];
  }

  function gateOnBase(base: number): number[] {
    // Transfer path gating on one mapping base through the same memory
    // pattern, reverting while the entry reads set.
    return [
      CALLDATALOAD,
      ...push1(0),
      MSTORE,
      ...push1(base),
      ...push1(0x20),
      MSTORE,
      ...push1(0x40),
      ...push1(0x00),
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

  function scoredInput(writeBase: number, gateBase: number): DetectorInput {
    const bytecode = tokenBytecode([
      { selector: SET_STATUS, body: setterOnBase(writeBase) },
      { selector: TRANSFER, body: gateOnBase(gateBase) },
    ]);
    return Object.freeze({ bytecode, codeHash: mustOk(CodeHash.of(bytecode)) });
  }

  test("privileged setter on one mapping with the gate on another stays silent", () => {
    // Registry-style shape: the guarded setter writes base 1 while the
    // transfer gate reads base 2, so no single mapping is proven.
    expect(blacklistDetectorPlugin.detect(scoredInput(1, 2))).toEqual([]);
  });

  test("privileged setter with the gate on the same base still reports", () => {
    const findings = blacklistDetectorPlugin.detect(scoredInput(3, 3));
    expect(findings).toHaveLength(1);
    expect(findings[0]?.payload).toEqual({ feature: "blacklist" });
  });
});

describe("blacklist fee-exempt and dual-gate precision (SCAN-1)", () => {
  function hexInput(hex: string): DetectorInput {
    const parsed = Bytecode.parse(hex);
    if (!parsed.ok) {
      throw new Error("fixture bytecode must parse");
    }
    return Object.freeze({ bytecode: parsed.value, codeHash: mustOk(CodeHash.of(parsed.value)) });
  }

  test("fee-exempt mapping that only skips a limit check stays silent", () => {
    // The guarded setter writes the mapping the shared transfer helper
    // reads, but a set entry only skips the limit compare: it never
    // gates a revert itself, so no blacklist is proven.
    expect(blacklistDetectorPlugin.detect(hexInput(feeExemptGateTokenHex()))).toEqual([]);
  });

  test("dual-entry gate on the same base reports an extended fact", () => {
    // Sender- and recipient-shaped entries of one mapping both revert
    // the shared transfer path while set, and the guarded setter writes
    // that base: a blacklist pair is proven.
    const findings = blacklistDetectorPlugin.detect(hexInput(dualBlacklistGateTokenHex()));
    expect(findings).toHaveLength(1);
    expect(findings[0]?.id).toBe("dev.brandklipparen.blacklist:blacklist-extended");
    expect(findings[0]?.payload).toEqual({ fact: "blacklist", proof: "extended" });
    const selectors = (findings[0]?.evidence ?? []).map((entry) => entry.selector as string).sort();
    expect(selectors).toEqual([DUAL_BLACKLIST_SET, TRANSFER_FROM_SELECTOR].sort());
  });
});

describe("blacklist enforce-style gates (SCAN-2)", () => {
  function hexInput(hex: string): DetectorInput {
    const parsed = Bytecode.parse(hex);
    if (!parsed.ok) {
      throw new Error("fixture bytecode must parse");
    }
    return Object.freeze({ bytecode: parsed.value, codeHash: mustOk(CodeHash.of(parsed.value)) });
  }

  test("jump-side revert gate on the written base reports an extended fact", () => {
    const findings = blacklistDetectorPlugin.detect(hexInput(jumpSideBlacklistTokenHex()));
    expect(findings).toHaveLength(1);
    expect(findings[0]?.id).toBe("dev.brandklipparen.blacklist:blacklist-extended");
    expect(findings[0]?.payload).toEqual({ fact: "blacklist", proof: "extended" });
  });

  test("jump-side gate on another base stays silent", () => {
    expect(blacklistDetectorPlugin.detect(hexInput(jumpSideBlacklistTokenHex(7, 8)))).toEqual([]);
  });

  test("scratch-offset mapping hash gate reports an extended fact", () => {
    const findings = blacklistDetectorPlugin.detect(hexInput(scratchOffsetBlacklistTokenHex()));
    expect(findings).toHaveLength(1);
    expect(findings[0]?.id).toBe("dev.brandklipparen.blacklist:blacklist-extended");
    expect(findings[0]?.payload).toEqual({ fact: "blacklist", proof: "extended" });
  });

  test("shuffled key store gate on the written base reports an extended fact", () => {
    const findings = blacklistDetectorPlugin.detect(hexInput(shuffledStoreBlacklistTokenHex()));
    expect(findings).toHaveLength(1);
    expect(findings[0]?.id).toBe("dev.brandklipparen.blacklist:blacklist-extended");
    expect(findings[0]?.payload).toEqual({ fact: "blacklist", proof: "extended" });
  });

  test("role-only guard without an owner slot proves the mapping writer", () => {
    const findings = blacklistDetectorPlugin.detect(hexInput(roleOnlyBlacklistTokenHex()));
    expect(findings).toHaveLength(1);
    expect(findings[0]?.id).toBe("dev.brandklipparen.blacklist:blacklist-extended");
    expect(findings[0]?.payload).toEqual({ fact: "blacklist", proof: "extended" });
  });

  test("shifted packed owner guard proves the mapping writer", () => {
    const findings = blacklistDetectorPlugin.detect(hexInput(shiftedOwnerBlacklistTokenHex()));
    expect(findings).toHaveLength(1);
    expect(findings[0]?.id).toBe("dev.brandklipparen.blacklist:blacklist-extended");
    expect(findings[0]?.payload).toEqual({ fact: "blacklist", proof: "extended" });
  });

  test("short-circuit listed-and-not-exempt gate reports an extended fact", () => {
    const findings = blacklistDetectorPlugin.detect(hexInput(shortCircuitBlacklistTokenHex()));
    expect(findings).toHaveLength(1);
    expect(findings[0]?.id).toBe("dev.brandklipparen.blacklist:blacklist-extended");
    expect(findings[0]?.payload).toEqual({ fact: "blacklist", proof: "extended" });
  });

  test("compound owner-or-role guard proves the mapping writer", () => {
    const findings = blacklistDetectorPlugin.detect(hexInput(compoundGuardBlacklistTokenHex()));
    expect(findings).toHaveLength(1);
    expect(findings[0]?.id).toBe("dev.brandklipparen.blacklist:blacklist-extended");
    expect(findings[0]?.payload).toEqual({ fact: "blacklist", proof: "extended" });
    const selectors = (findings[0]?.evidence ?? []).map((entry) => entry.selector as string).sort();
    expect(selectors).toEqual([COMPOUND_SET, TRANSFER].sort());
  });

  test("balance compare on the credited mapping stays silent", () => {
    expect(blacklistDetectorPlugin.detect(hexInput(balanceGateTokenHex()))).toEqual([]);
    expect(BALANCE_GATE_SET).toBe("0x0a9c6c1e");
  });
});

describe("blacklist exemption precision (SCAN-R)", () => {
  function hexInput(hex: string): DetectorInput {
    const parsed = Bytecode.parse(hex);
    if (!parsed.ok) {
      throw new Error("fixture bytecode must parse");
    }
    return Object.freeze({ bytecode: parsed.value, codeHash: mustOk(CodeHash.of(parsed.value)) });
  }

  test("subtraction-guarded fee-exempt setter beside a trading flag stays silent", () => {
    // The exempt entry only opens the transfer beside the trading
    // flag: its subtraction-guarded setter is a proven writer, but
    // the transfer gate is an exemption, so no blacklist fact stands.
    expect(blacklistDetectorPlugin.detect(hexInput(scanRSubGuardFeeExemptTokenHex()))).toEqual([]);
  });

  test("subtraction-guarded blacklist setter reports an extended fact", () => {
    const findings = blacklistDetectorPlugin.detect(hexInput(scanRSubGuardBlacklistTokenHex()));
    expect(findings).toHaveLength(1);
    expect(findings[0]?.id).toBe("dev.brandklipparen.blacklist:blacklist-extended");
  });

  test("exempt entry that still runs a reverting limit check stays silent", () => {
    // Both continuations of the exempt read run a limit compare
    // that can revert before the balance store: a reachable revert
    // past an exemption never proves the entry blocks a transfer.
    expect(blacklistDetectorPlugin.detect(hexInput(scanRExemptLimitTokenHex()))).toEqual([]);
  });
});
