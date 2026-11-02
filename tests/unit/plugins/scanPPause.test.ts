// SCAN-P pause idioms from the dev set, reproduced as synthetic
// bytecode. Catalogue (source idiom -> compiled shape):
// - OZ Pausable `whenNotPaused` on `_update` with `pause()`/
//   `unpause()` writers: an internal flag load feeding a conditional
//   jump to a revert inside the shared transfer helper, with guarded
//   stores of both 1 and 0 to the same bool slot.
// - Hand-rolled `bool paused` with `pause()`/`unpause()`: the same
//   load/jump/revert gate in `transfer`/`transferFrom` itself.
// - `pauseTrading()`/`unpauseTrading()`: each writer first requires
//   the flag's current value, then stores the opposite constant.
// - Feature-flag pause (`pausable && _paused`): the gate is the AND
//   of two bool loads; only the pause flag has writers.
// - Reversible trading toggle (`enableTrading`/`disableTrading`):
//   the gate is `flag || exempt[from] || exempt[to]` short-circuited
//   over two jumps; both constants are written, so it is a pause.
// - Bool-argument setter (`setTrading(bool)`/`setPaused(bool)`):
//   one guarded writer stores the cleaned calldata bool
//   (`ISZERO ISZERO` or `AND 1`), so one entry writes both values.
// - Early-return gate: the blocked side returns with no balance
//   write instead of reverting.
// Negatives: a one-way enable (only the constant 1 is ever written)
// is not a pause, a fee-exempt mapping proves no flag, and a raw
// calldata word proves no boolean. Assertions check the reported
// fact and mode, never internal proof steps.
import { describe, expect, test } from "vitest";
import { Bytecode, CodeHash } from "../../../src/domain/types.ts";
import type { DetectorInput } from "../../../src/plugins/detector.ts";
import type { Result } from "../../../src/domain/result.ts";
import { pauseDetectorPlugin } from "../../../src/plugins/detectors/pause/index.ts";
import {
  andGatePauseTokenHex,
  boolArgPauseTokenHex,
  boolArgTradingTokenHex,
  earlyReturnPauseTokenHex,
  feeExemptBoolArgTokenHex,
  preconditionPairPauseTokenHex,
  rawCalldataRateTokenHex,
  tradingToggleExemptTokenHex,
} from "../../helpers/ownerControlFixtures.ts";

function mustOk<T, E extends { message: string }>(result: Result<T, E>): T {
  if (!result.ok) {
    throw new Error(`expected ok, got error: ${result.error.message}`);
  }
  return result.value;
}

function inputOf(hex: string): DetectorInput {
  const parsed = Bytecode.parse(hex);
  if (!parsed.ok) {
    throw new Error(`expected valid bytecode, got error: ${parsed.error.message}`);
  }
  return Object.freeze({ bytecode: parsed.value, codeHash: mustOk(CodeHash.of(parsed.value)) });
}

describe("SCAN-P pause idioms", () => {
  test("bool-argument setter with normalized calldata reports an extended pause fact", () => {
    const findings = pauseDetectorPlugin.detect(inputOf(boolArgPauseTokenHex()));
    expect(findings).toHaveLength(1);
    expect(findings[0]?.id).toBe("dev.brandklipparen.pause:pause-extended");
    expect(findings[0]?.payload).toEqual({ fact: "pause", slot: 4, mode: "pause", proof: "extended" });
  });

  test("bool-argument trading switch with an exemption bypass reports an extended pause fact", () => {
    const findings = pauseDetectorPlugin.detect(inputOf(boolArgTradingTokenHex()));
    expect(findings).toHaveLength(1);
    expect(findings[0]?.id).toBe("dev.brandklipparen.pause:pause-extended");
    expect(findings[0]?.payload).toEqual({ fact: "pause", slot: 4, mode: "pause", proof: "extended" });
  });

  test("early-return gate with reversible writers reports an extended pause fact", () => {
    const findings = pauseDetectorPlugin.detect(inputOf(earlyReturnPauseTokenHex()));
    expect(findings).toHaveLength(1);
    expect(findings[0]?.payload).toMatchObject({ fact: "pause", proof: "extended", mode: "pause" });
  });

  test("two-flag AND gate with reversible writers reports a pause finding", () => {
    const findings = pauseDetectorPlugin.detect(inputOf(andGatePauseTokenHex()));
    expect(findings).toHaveLength(1);
    expect(findings[0]?.payload).toMatchObject({ slot: 4, mode: "pause" });
  });

  test("precondition writers with a pair-and-whitelist gate report a pause finding", () => {
    const findings = pauseDetectorPlugin.detect(inputOf(preconditionPairPauseTokenHex()));
    expect(findings).toHaveLength(1);
    expect(findings[0]?.payload).toMatchObject({ slot: 4, mode: "pause" });
  });

  test("one-way trading enable with an exemption bypass stays silent", () => {
    expect(pauseDetectorPlugin.detect(inputOf(tradingToggleExemptTokenHex(false)))).toEqual([]);
  });

  test("fee-exempt mapping with a bool-argument writer stays silent", () => {
    expect(pauseDetectorPlugin.detect(inputOf(feeExemptBoolArgTokenHex()))).toEqual([]);
  });

  test("raw calldata rate with a zero branch stays silent", () => {
    expect(pauseDetectorPlugin.detect(inputOf(rawCalldataRateTokenHex()))).toEqual([]);
  });
});
