// SCAN-3 detector idioms from the real dev set, reproduced as
// synthetic bytecode: array-loop list writers, feature-flag batch
// setters, internal pause helpers, reversible trading toggles with
// exemption bypasses, pair-only pause gates, dual-rate fee setters,
// scaled and removable limits, a block-number gate, and burn shapes
// that must never read as mint. Assertions check the reported fact
// and its weight-0 extended proof, never internal proof steps.
import { describe, expect, test } from "vitest";
import { Bytecode, CodeHash } from "../../../src/domain/types.ts";
import type { DetectorInput } from "../../../src/plugins/detector.ts";
import type { Result } from "../../../src/domain/result.ts";
import { blacklistDetectorPlugin } from "../../../src/plugins/detectors/blacklist/index.ts";
import { pauseDetectorPlugin } from "../../../src/plugins/detectors/pause/index.ts";
import { transferFeeDetectorPlugin } from "../../../src/plugins/detectors/transfer-fee/index.ts";
import { transferLimitsDetectorPlugin } from "../../../src/plugins/detectors/transfer-limits/index.ts";
import { mintDetectorPlugin } from "../../../src/plugins/detectors/mint/index.ts";
import {
  blockNumberGateTokenHex,
  botsArrayBlacklistTokenHex,
  burnOnlyTokenHex,
  callerKeyedBlacklistTokenHex,
  deadSetterBlacklistTokenHex,
  dualRateFeeTokenHex,
  exemptSkipLimitTokenHex,
  featureFlagBatchBlacklistTokenHex,
  internalClearPauseTokenHex,
  internalPauseTokenHex,
  nestedRoleFrozenTokenHex,
  pairOnlyPauseTokenHex,
  removableLimitTokenHex,
  scaledLimitTokenHex,
  storedRecipientMintTokenHex,
  structFeeTokenHex,
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

describe("SCAN-3 blacklist idioms", () => {
  test("array-loop bots writer with a two-entry gate reports an extended blacklist fact", () => {
    const findings = blacklistDetectorPlugin.detect(inputOf(botsArrayBlacklistTokenHex()));
    expect(findings).toHaveLength(1);
    expect(findings[0]?.payload).toEqual({ fact: "blacklist", proof: "extended" });
  });

  test("feature-flag batch setter with a jump-side gate reports an extended blacklist fact", () => {
    const findings = blacklistDetectorPlugin.detect(inputOf(featureFlagBatchBlacklistTokenHex()));
    expect(findings).toHaveLength(1);
    expect(findings[0]?.payload).toEqual({ fact: "blacklist", proof: "extended" });
  });

  test("nested role-guarded frozen writer with a jump-side gate reports an extended blacklist fact", () => {
    const findings = blacklistDetectorPlugin.detect(inputOf(nestedRoleFrozenTokenHex()));
    expect(findings).toHaveLength(1);
    expect(findings[0]?.payload).toEqual({ fact: "blacklist", proof: "extended" });
  });

  test("caller-keyed gate with a guarded writer reports an extended blacklist fact", () => {
    const findings = blacklistDetectorPlugin.detect(inputOf(callerKeyedBlacklistTokenHex()));
    expect(findings).toHaveLength(1);
    expect(findings[0]?.payload).toEqual({ fact: "blacklist", proof: "extended" });
  });

  test("guarded list setter the transfer path never reads stays silent", () => {
    expect(blacklistDetectorPlugin.detect(inputOf(deadSetterBlacklistTokenHex()))).toEqual([]);
  });

  test("exemption mapping that only skips a limit compare stays silent", () => {
    expect(blacklistDetectorPlugin.detect(inputOf(exemptSkipLimitTokenHex()))).toEqual([]);
  });
});

describe("SCAN-3 pause idioms", () => {
  test("pause writers through a shared internal helper report an extended pause fact", () => {
    const findings = pauseDetectorPlugin.detect(inputOf(internalPauseTokenHex()));
    expect(findings).toHaveLength(1);
    expect(findings[0]?.payload).toMatchObject({ fact: "pause", proof: "extended" });
  });

  test("clear write through a shared helper still proves the pause mode", () => {
    const findings = pauseDetectorPlugin.detect(inputOf(internalClearPauseTokenHex()));
    expect(findings).toHaveLength(1);
    expect(findings[0]?.payload).toMatchObject({ fact: "pause", proof: "extended", mode: "pause" });
  });

  test("reversible trading toggle with an exemption bypass reports an extended pause fact", () => {
    const findings = pauseDetectorPlugin.detect(inputOf(tradingToggleExemptTokenHex(true)));
    expect(findings).toHaveLength(1);
    expect(findings[0]?.payload).toMatchObject({ fact: "pause", proof: "extended", mode: "pause" });
  });

  test("one-way trading toggle with an exemption bypass stays silent", () => {
    expect(pauseDetectorPlugin.detect(inputOf(tradingToggleExemptTokenHex(false)))).toEqual([]);
  });

  test("pair-only pause gate reports a pause finding", () => {
    const findings = pauseDetectorPlugin.detect(inputOf(pairOnlyPauseTokenHex()));
    expect(findings).toHaveLength(1);
    expect(findings[0]?.payload).toMatchObject({ slot: 4, mode: "pause" });
  });
});

describe("SCAN-3 fee and limit idioms", () => {
  test("dual-rate setter with a cap compare reports a fee finding", () => {
    const findings = transferFeeDetectorPlugin.detect(inputOf(dualRateFeeTokenHex()));
    expect(findings).toHaveLength(1);
    expect(findings[0]?.payload).toMatchObject({ slot: 5, maxFeeBasisPoints: 1000 });
  });

  test("struct fee setter whose fields sum into the rate reports a fee finding", () => {
    const findings = transferFeeDetectorPlugin.detect(inputOf(structFeeTokenHex()));
    expect(findings).toHaveLength(1);
    expect(findings[0]?.payload).toMatchObject({ slot: 5 });
  });

  test("scaled limit setter with a shared balance gate reports an extended limits fact", () => {
    const findings = transferLimitsDetectorPlugin.detect(inputOf(scaledLimitTokenHex()));
    expect(findings).toHaveLength(1);
    expect(findings[0]?.payload).toMatchObject({ fact: "transfer-limits", proof: "extended" });
  });

  test("large-constant remove-limits writer reports a limits finding", () => {
    const findings = transferLimitsDetectorPlugin.detect(inputOf(removableLimitTokenHex()));
    expect(findings).toHaveLength(1);
    expect(findings[0]?.payload).toMatchObject({ slot: 6 });
  });

  test("block-number gate with a computed writer stays silent for limits", () => {
    expect(transferLimitsDetectorPlugin.detect(inputOf(blockNumberGateTokenHex()))).toEqual([]);
  });
});

describe("SCAN-3 mint idioms", () => {
  test("stored-recipient supply increase reports an extended mint fact", () => {
    const findings = mintDetectorPlugin.detect(inputOf(storedRecipientMintTokenHex()));
    expect(findings).toHaveLength(1);
    expect(findings[0]?.payload).toMatchObject({ fact: "mint", proof: "extended" });
  });

  test("public burn that only decreases supply stays silent for mint", () => {
    expect(mintDetectorPlugin.detect(inputOf(burnOnlyTokenHex()))).toEqual([]);
  });
});
