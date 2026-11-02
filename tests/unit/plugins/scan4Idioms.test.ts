// SCAN-4 detector idioms from the real dev set, reproduced as
// synthetic bytecode: a direct (non-shared) exemption branch that must
// never read as a blacklist, pause and blacklist gates routed through
// internal bool helpers, a list writer whose keys arrive from memory,
// and a custom-error gate whose revert sits far past the gate jump.
// Assertions check the reported fact and its weight-0 extended proof,
// never internal proof steps.
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
  antiWhaleLimitTokenHex,
  boolHelperBlacklistTokenHex,
  boolHelperPauseTokenHex,
  burnThroughUpdateTokenHex,
  customErrorBlacklistTokenHex,
  enforceGuardBlacklistTokenHex,
  directExemptBlacklistTokenHex,
  getterHelperBlacklistTokenHex,
  internalMintTokenHex,
  internalSetterFeeTokenHex,
  maxWalletLimitTokenHex,
  namespacedPauseTokenHex,
  packedSlotPauseTokenHex,
  packedStructFeeTokenHex,
  snipeWindowLimitTokenHex,
  memoryKeyBotsBlacklistTokenHex,
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

describe("SCAN-4 blacklist idioms", () => {
  test("exemption branch in the transfer entry itself stays silent", () => {
    expect(blacklistDetectorPlugin.detect(inputOf(directExemptBlacklistTokenHex()))).toEqual([]);
  });

  test("enforce-guard with an exemption entry reports an extended blacklist fact", () => {
    const findings = blacklistDetectorPlugin.detect(inputOf(enforceGuardBlacklistTokenHex()));
    expect(findings).toHaveLength(1);
    expect(findings[0]?.payload).toEqual({ fact: "blacklist", proof: "extended" });
  });

  test("require-helper gate reports an extended blacklist fact", () => {
    const findings = blacklistDetectorPlugin.detect(inputOf(boolHelperBlacklistTokenHex()));
    expect(findings).toHaveLength(1);
    expect(findings[0]?.payload).toEqual({ fact: "blacklist", proof: "extended" });
  });

  test("getter-helper gate through a shared helper reports an extended blacklist fact", () => {
    const findings = blacklistDetectorPlugin.detect(inputOf(getterHelperBlacklistTokenHex()));
    expect(findings).toHaveLength(1);
    expect(findings[0]?.payload).toEqual({ fact: "blacklist", proof: "extended" });
  });

  test("memory-key array writer with a two-entry gate reports an extended blacklist fact", () => {
    const findings = blacklistDetectorPlugin.detect(inputOf(memoryKeyBotsBlacklistTokenHex()));
    expect(findings).toHaveLength(1);
    expect(findings[0]?.payload).toEqual({ fact: "blacklist", proof: "extended" });
  });

  test("custom-error gate with a long revert block reports a blacklist fact", () => {
    const findings = blacklistDetectorPlugin.detect(inputOf(customErrorBlacklistTokenHex()));
    expect(findings.length).toBeGreaterThanOrEqual(1);
    expect(findings[0]?.payload).toMatchObject({ proof: "extended" });
  });
});

describe("SCAN-4 fee, limit and mint idioms", () => {
  test("packed fee-struct setter with an extracted rate reports a fee finding", () => {
    const findings = transferFeeDetectorPlugin.detect(inputOf(packedStructFeeTokenHex()));
    expect(findings).toHaveLength(1);
    expect(findings[0]?.payload).toMatchObject({ slot: 5 });
  });

  test("fee setter through a shared internal helper reports a fee finding", () => {
    const findings = transferFeeDetectorPlugin.detect(inputOf(internalSetterFeeTokenHex()));
    expect(findings).toHaveLength(1);
    expect(findings[0]?.payload).toMatchObject({ slot: 5 });
  });

  test("max-wallet gate over balance plus amount reports a limits finding", () => {
    const findings = transferLimitsDetectorPlugin.detect(inputOf(maxWalletLimitTokenHex()));
    expect(findings).toHaveLength(1);
    expect(findings[0]?.payload).toMatchObject({ slot: 6 });
  });

  test("anti-whale struct setter with a shared gate reports a limits finding", () => {
    const findings = transferLimitsDetectorPlugin.detect(inputOf(antiWhaleLimitTokenHex()));
    expect(findings).toHaveLength(1);
    expect(findings[0]?.payload).toMatchObject({ slot: 6 });
  });

  test("block-number snipe window with an automatic listing store stays silent for limits", () => {
    expect(transferLimitsDetectorPlugin.detect(inputOf(snipeWindowLimitTokenHex()))).toEqual([]);
  });

  test("burn through a shared update helper stays silent for mint", () => {
    expect(mintDetectorPlugin.detect(inputOf(burnThroughUpdateTokenHex()))).toEqual([]);
  });

  test("mint through a shared internal helper reports a mint finding", () => {
    const findings = mintDetectorPlugin.detect(inputOf(internalMintTokenHex()));
    expect(findings).toHaveLength(1);
  });
});

describe("SCAN-4 pause idioms", () => {
  test("namespaced wide-slot gate reports a pause fact", () => {
    const findings = pauseDetectorPlugin.detect(inputOf(namespacedPauseTokenHex()));
    expect(findings).toHaveLength(1);
    expect(findings[0]?.payload).toMatchObject({ mode: "pause" });
  });

  test("packed slot bit gate reports an extended pause fact", () => {
    const findings = pauseDetectorPlugin.detect(inputOf(packedSlotPauseTokenHex()));
    expect(findings).toHaveLength(1);
    expect(findings[0]?.payload).toMatchObject({ fact: "pause", proof: "extended", mode: "pause" });
  });

  test("getter-helper gate without load-to-condition dataflow stays silent", () => {
    expect(pauseDetectorPlugin.detect(inputOf(boolHelperPauseTokenHex()))).toEqual([]);
  });
});
