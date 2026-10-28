// Specificity tests (S-115 follow-up): each owner-control detector must
// require its own behavioural evidence. Every pattern below is synthetic
// hand-assembled bytecode, no real tokens. Each detector fires its own
// pattern and stays silent on the other three patterns and on a plain
// ERC20 with Ownable; blacklist and sell-block additionally stay silent
// on permit-style, votes-style and allowance patterns while a USDC-style
// blacklist still fires; transfer-hooks fires only on external CALLs to
// non-constant targets.
import { describe, expect, test } from "vitest";
import { CodeHash } from "../../../src/domain/types.ts";
import type { DetectorInput } from "../../../src/plugins/detector.ts";
import type { Result } from "../../../src/domain/result.ts";
import { mintDetectorPlugin } from "../../../src/plugins/detectors/mint/index.ts";
import { pauseDetectorPlugin } from "../../../src/plugins/detectors/pause/index.ts";
import { transferFeeDetectorPlugin } from "../../../src/plugins/detectors/transfer-fee/index.ts";
import { transferLimitsDetectorPlugin } from "../../../src/plugins/detectors/transfer-limits/index.ts";
import { blacklistDetectorPlugin } from "../../../src/plugins/detectors/blacklist/index.ts";
import { sellBlockDetectorPlugin } from "../../../src/plugins/detectors/sell-block/index.ts";
import { transferHooksDetectorPlugin } from "../../../src/plugins/detectors/transfer-hooks/index.ts";
import {
  ADD,
  CALL,
  CALLDATALOAD,
  EQ,
  ISZERO,
  JUMPI,
  KECCAK,
  LT,
  MUL,
  REVERT,
  SLOAD,
  SSTORE,
  STATICCALL,
  STOP,
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
const TRANSFER_FROM = "0x23b872dd";
const APPROVE = "0x095ea7b3";
const PERMIT = "0xd505accf";
const SETTER = "0x0a9c6c1e";
const CHECKPOINTS = "0xdeadbeef";

// One mapping store with a caller-chosen key: key material, then the slot
// number, hashed, stored. The adjacent KECCAK marks mapping access.
function sstoreMapping(slot: number, keyPrefix: readonly number[]): number[] {
  return [...keyPrefix, ...push1(slot), KECCAK, SSTORE];
}

// One mapping load: slot number hashed then loaded.
function sloadMapping(slot: number, keyPrefix: readonly number[]): number[] {
  return [...keyPrefix, ...push1(slot), KECCAK, SLOAD];
}

// A balance sufficiency gate: mapping load, amount compare, revert.
function balanceGate(slot: number): number[] {
  return [
    ...sloadMapping(slot, [CALLDATALOAD]),
    CALLDATALOAD,
    LT,
    ISZERO,
    ...push1(90),
    JUMPI,
    ...push1(0),
    0x80,
    REVERT,
    0x5b,
  ];
}

function fireCount(
  plugin: { detect: (input: DetectorInput) => readonly unknown[] },
  bytecode: ReturnType<typeof tokenBytecode>,
): number {
  return plugin.detect(toInput(bytecode)).length;
}

// Mint shape: privileged supply increase (ADD beside the store) with a
// balance credit to a caller-chosen address, read back in the transfer.
function mintBytecode(): ReturnType<typeof tokenBytecode> {
  return tokenBytecode([
    {
      selector: SETTER,
      body: [
        ...ownerGuard(0, 200),
        CALLDATALOAD,
        ...push1(1),
        SLOAD,
        ADD,
        ...sstoreConstSlot(1, []),
        ...sstoreMapping(2, [CALLDATALOAD]),
        STOP,
      ],
    },
    {
      selector: TRANSFER,
      body: [CALLDATALOAD, ...push1(1), SLOAD, ADD, ...sstoreConstSlot(2, [CALLDATALOAD]), STOP],
    },
  ]);
}

// Fee shape: privileged caller-chosen rate with multiply and subtract in
// the transfer.
function feeBytecode(): ReturnType<typeof tokenBytecode> {
  return tokenBytecode([
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
}

// Pause shape: privileged constant flag with an ISZERO gate in the
// transfer beside an unrelated amount bound.
function pauseBytecode(): ReturnType<typeof tokenBytecode> {
  return tokenBytecode([
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
}

// Limits shape: privileged caller-chosen limit compared in the transfer.
function limitsBytecode(): ReturnType<typeof tokenBytecode> {
  return tokenBytecode([
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
}

// Plain ERC20 with Ownable: balances mapping with a balance gate, user
// approval writes, and a guarded owner transfer, but no fee, pause,
// limit, mint, blacklist, sell-block or hook behaviour.
function plainOzBytecode(): ReturnType<typeof tokenBytecode> {
  return tokenBytecode([
    {
      selector: TRANSFER,
      body: [
        ...balanceGate(2),
        ...sloadMapping(2, [CALLDATALOAD]),
        SUB,
        ...sstoreMapping(2, [CALLDATALOAD]),
        ...sstoreMapping(2, [CALLDATALOAD]),
        STOP,
      ],
    },
    {
      selector: APPROVE,
      body: [...sstoreMapping(4, [CALLDATALOAD]), STOP],
    },
    {
      selector: SETTER,
      body: [...ownerGuard(0, 200), ...sstoreConstSlot(0, [CALLDATALOAD]), STOP],
    },
  ]);
}

describe("detector specificity: mint, fee, pause and limits", () => {
  test("mint pattern fires mint only", () => {
    const bytecode = mintBytecode();
    expect(mintDetectorPlugin.detect(toInput(bytecode))).toHaveLength(1);
    expect(fireCount(transferFeeDetectorPlugin, bytecode)).toBe(0);
    expect(fireCount(pauseDetectorPlugin, bytecode)).toBe(0);
    expect(fireCount(transferLimitsDetectorPlugin, bytecode)).toBe(0);
  });

  test("fee pattern fires fee only", () => {
    const bytecode = feeBytecode();
    expect(transferFeeDetectorPlugin.detect(toInput(bytecode))).toHaveLength(1);
    expect(fireCount(mintDetectorPlugin, bytecode)).toBe(0);
    expect(fireCount(pauseDetectorPlugin, bytecode)).toBe(0);
    expect(fireCount(transferLimitsDetectorPlugin, bytecode)).toBe(0);
  });

  test("pause pattern fires pause only", () => {
    const bytecode = pauseBytecode();
    expect(pauseDetectorPlugin.detect(toInput(bytecode))).toHaveLength(1);
    expect(fireCount(mintDetectorPlugin, bytecode)).toBe(0);
    expect(fireCount(transferFeeDetectorPlugin, bytecode)).toBe(0);
    expect(fireCount(transferLimitsDetectorPlugin, bytecode)).toBe(0);
  });

  test("limits pattern fires limits only", () => {
    const bytecode = limitsBytecode();
    expect(transferLimitsDetectorPlugin.detect(toInput(bytecode))).toHaveLength(1);
    expect(fireCount(mintDetectorPlugin, bytecode)).toBe(0);
    expect(fireCount(transferFeeDetectorPlugin, bytecode)).toBe(0);
    expect(fireCount(pauseDetectorPlugin, bytecode)).toBe(0);
  });

  test("plain ERC20 with Ownable fires none of the four", () => {
    const bytecode = plainOzBytecode();
    expect(fireCount(mintDetectorPlugin, bytecode)).toBe(0);
    expect(fireCount(transferFeeDetectorPlugin, bytecode)).toBe(0);
    expect(fireCount(pauseDetectorPlugin, bytecode)).toBe(0);
    expect(fireCount(transferLimitsDetectorPlugin, bytecode)).toBe(0);
  });
});

describe("detector specificity: blacklist and sell-block", () => {
  test("plain ERC20 with Ownable fires neither gate", () => {
    const bytecode = plainOzBytecode();
    expect(fireCount(blacklistDetectorPlugin, bytecode)).toBe(0);
    expect(fireCount(sellBlockDetectorPlugin, bytecode)).toBe(0);
  });

  test("permit-style staticcall fires neither gate", () => {
    const bytecode = tokenBytecode([
      {
        selector: PERMIT,
        body: [CALLDATALOAD, ...push1(1), STATICCALL, ...sstoreConstSlot(3, [CALLDATALOAD]), STOP],
      },
      {
        selector: TRANSFER,
        body: [...balanceGate(2), ...sstoreConstSlot(2, [CALLDATALOAD]), STOP],
      },
    ]);
    expect(fireCount(blacklistDetectorPlugin, bytecode)).toBe(0);
    expect(fireCount(sellBlockDetectorPlugin, bytecode)).toBe(0);
  });

  test("votes-style checkpoints fire neither gate", () => {
    const bytecode = tokenBytecode([
      {
        selector: CHECKPOINTS,
        body: [...sstoreMapping(5, [CALLDATALOAD]), ...sloadMapping(5, [CALLDATALOAD]), STOP],
      },
      {
        selector: TRANSFER,
        body: [...balanceGate(2), ...sstoreMapping(2, [CALLDATALOAD]), STOP],
      },
    ]);
    expect(fireCount(blacklistDetectorPlugin, bytecode)).toBe(0);
    expect(fireCount(sellBlockDetectorPlugin, bytecode)).toBe(0);
  });

  test("allowance check in transferFrom does not prove a blacklist", () => {
    const bytecode = tokenBytecode([
      {
        selector: TRANSFER_FROM,
        body: [
          ...sloadMapping(4, [CALLDATALOAD]),
          CALLDATALOAD,
          LT,
          ISZERO,
          ...push1(90),
          JUMPI,
          ...push1(0),
          0x80,
          REVERT,
          0x5b,
          ...sstoreMapping(4, [CALLDATALOAD]),
          ...sstoreMapping(2, [CALLDATALOAD]),
          STOP,
        ],
      },
    ]);
    expect(fireCount(blacklistDetectorPlugin, bytecode)).toBe(0);
  });

  test("owner-gated mapping gate still proves a blacklist", () => {
    const bytecode = tokenBytecode([
      {
        selector: SETTER,
        body: [...ownerGuard(0, 200), ...sstoreMapping(3, [CALLDATALOAD]), STOP],
      },
      {
        selector: TRANSFER,
        body: [
          ...sloadMapping(3, [CALLDATALOAD]),
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
    const findings = blacklistDetectorPlugin.detect(toInput(bytecode));
    expect(findings).toHaveLength(1);
    expect(findings[0]?.payload).toEqual({ feature: "blacklist" });
  });

  test("owner-set pair gate still proves a sell-block", () => {
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
    const findings = sellBlockDetectorPlugin.detect(toInput(bytecode));
    expect(findings).toHaveLength(1);
    expect(findings[0]?.payload).toEqual({ feature: "sell-block", condition: "recipient-equals-stored" });
  });
});

describe("detector specificity: transfer-hooks", () => {
  test("permit-style staticcall does not prove a hook", () => {
    const bytecode = tokenBytecode([
      {
        selector: TRANSFER,
        body: [CALLDATALOAD, ...push1(1), STATICCALL, ...sstoreConstSlot(2, [CALLDATALOAD]), STOP],
      },
    ]);
    expect(fireCount(transferHooksDetectorPlugin, bytecode)).toBe(0);
  });

  test("call to a constant target does not prove a hook", () => {
    const bytecode = tokenBytecode([
      {
        selector: TRANSFER,
        body: [
          CALLDATALOAD,
          0x73,
          ...new Array<number>(20).fill(0x11),
          CALL,
          ...sstoreConstSlot(2, [CALLDATALOAD]),
          STOP,
        ],
      },
    ]);
    expect(fireCount(transferHooksDetectorPlugin, bytecode)).toBe(0);
  });

  test("call to an unresolvable target proves a hook", () => {
    const bytecode = tokenBytecode([
      {
        selector: TRANSFER,
        body: [
          ...push1(3),
          SLOAD,
          0x80,
          0x80,
          0x80,
          0x80,
          0x80,
          0x80,
          0x80,
          0x80,
          0x80,
          0x80,
          0x80,
          0x80,
          0x80,
          CALL,
          ...sstoreConstSlot(2, [CALLDATALOAD]),
          STOP,
        ],
      },
    ]);
    const findings = transferHooksDetectorPlugin.detect(toInput(bytecode));
    expect(findings).toHaveLength(1);
    expect(findings[0]?.payload).toEqual({ feature: "transfer-hooks", callKind: "call", target: "unknown" });
  });

  test("call to a stored target proves a hook", () => {
    const bytecode = tokenBytecode([
      {
        selector: TRANSFER,
        body: [
          CALLDATALOAD,
          ...push1(7),
          SLOAD,
          CALL,
          ...sstoreConstSlot(2, [CALLDATALOAD]),
          STOP,
        ],
      },
    ]);
    const findings = transferHooksDetectorPlugin.detect(toInput(bytecode));
    expect(findings).toHaveLength(1);
    expect(findings[0]?.payload).toEqual({ feature: "transfer-hooks", callKind: "call", target: "storage" });
    expect(fireCount(mintDetectorPlugin, bytecode)).toBe(0);
    expect(fireCount(transferFeeDetectorPlugin, bytecode)).toBe(0);
    expect(fireCount(pauseDetectorPlugin, bytecode)).toBe(0);
    expect(fireCount(transferLimitsDetectorPlugin, bytecode)).toBe(0);
    expect(fireCount(blacklistDetectorPlugin, bytecode)).toBe(0);
    expect(fireCount(sellBlockDetectorPlugin, bytecode)).toBe(0);
  });
});
