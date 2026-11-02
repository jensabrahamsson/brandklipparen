// SCAN-4 synthetic fixture measurement at idiom-class granularity.
// Each row is one hand-written synthetic fixture reproducing an idiom
// class; the `tokens` field records how many real tokens were assigned
// to that class for provenance only and is never used as a weight.
// Counts below are per-fixture-class outcomes on synthetic bytecode:
// they do not measure accuracy on the real contracts, whose runtime
// bytecode is not in this repository.
import { describe, expect, test } from "vitest";
import { Bytecode, CodeHash } from "../../../src/domain/types.ts";
import type { DetectorInput, PluginFinding } from "../../../src/plugins/detector.ts";
import type { Result } from "../../../src/domain/result.ts";
import { blacklistDetectorPlugin } from "../../../src/plugins/detectors/blacklist/index.ts";
import { pauseDetectorPlugin } from "../../../src/plugins/detectors/pause/index.ts";
import { transferFeeDetectorPlugin } from "../../../src/plugins/detectors/transfer-fee/index.ts";
import { transferLimitsDetectorPlugin } from "../../../src/plugins/detectors/transfer-limits/index.ts";
import { mintDetectorPlugin } from "../../../src/plugins/detectors/mint/index.ts";
import {
  antiWhaleLimitTokenHex,
  arrayShareFeeTokenHex,
  boolHelperBlacklistTokenHex,
  boolHelperPauseTokenHex,
  burnThroughUpdateTokenHex,
  callerKeyedBlacklistTokenHex,
  customErrorBlacklistTokenHex,
  deadSetterBlacklistTokenHex,
  directExemptBlacklistTokenHex,
  dualRateFeeTokenHex,
  enforceGuardBlacklistTokenHex,
  getterHelperBlacklistTokenHex,
  internalMintTokenHex,
  internalSetterFeeTokenHex,
  memoryKeyBotsBlacklistTokenHex,
  nestedRoleFrozenTokenHex,
  oz4BlacklistTokenHex,
  packedSlotPauseTokenHex,
  packedStructFeeTokenHex,
  pairOnlyPauseTokenHex,
  scaledLimitTokenHex,
  snipeWindowLimitTokenHex,
  storedRecipientMintTokenHex,
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

type Power = "blacklist" | "pause" | "fee" | "limits" | "mint";

function present(power: Power, findings: readonly PluginFinding[]): boolean {
  if (power === "pause") {
    // A one-way trading toggle is its own class, never a pause.
    return findings.some(
      (finding) =>
        (finding.payload as { mode?: unknown }).mode !== "trading-toggle" &&
        JSON.stringify(finding.payload).includes("pause"),
    );
  }
  return findings.length > 0;
}

function detect(power: Power, hex: string): boolean {
  const input = inputOf(hex);
  switch (power) {
    case "blacklist":
      return present(power, blacklistDetectorPlugin.detect(input));
    case "pause":
      return present(power, pauseDetectorPlugin.detect(input));
    case "fee":
      return present(power, transferFeeDetectorPlugin.detect(input));
    case "limits":
      return present(power, transferLimitsDetectorPlugin.detect(input));
    case "mint":
      return present(power, mintDetectorPlugin.detect(input));
  }
}

// One row per idiom class: fixture, verified-token count, label.
type ClassRow = {
  readonly power: Power;
  readonly cls: string;
  readonly tokens: number;
  readonly label: boolean;
  readonly hex: () => string;
};

const CLASSES: readonly ClassRow[] = [
  // Blacklist positives (20 verified tokens).
  { power: "blacklist", cls: "memory-key array writer, two-entry gate", tokens: 6, label: true, hex: memoryKeyBotsBlacklistTokenHex },
  { power: "blacklist", cls: "caller-keyed gate in transfer entries", tokens: 7, label: true, hex: callerKeyedBlacklistTokenHex },
  { power: "blacklist", cls: "custom-error gate in update", tokens: 1, label: true, hex: customErrorBlacklistTokenHex },
  { power: "blacklist", cls: "require-helper gate from update", tokens: 1, label: true, hex: boolHelperBlacklistTokenHex },
  { power: "blacklist", cls: "enforce-guard with exemption entry", tokens: 2, label: true, hex: enforceGuardBlacklistTokenHex },
  { power: "blacklist", cls: "getter-helper gate from update", tokens: 1, label: true, hex: getterHelperBlacklistTokenHex },
  { power: "blacklist", cls: "role-guarded freeze in update", tokens: 1, label: true, hex: nestedRoleFrozenTokenHex },
  { power: "blacklist", cls: "single setter, two-entry gate", tokens: 1, label: true, hex: () => oz4BlacklistTokenHex() },
  // Blacklist negatives (14 verified tokens).
  { power: "blacklist", cls: "fee-exemption branch in transfer entry", tokens: 1, label: false, hex: directExemptBlacklistTokenHex },
  { power: "blacklist", cls: "dead setter never read in transfer", tokens: 5, label: false, hex: deadSetterBlacklistTokenHex },
  { power: "blacklist", cls: "no list power (pause-only token)", tokens: 8, label: false, hex: boolHelperPauseTokenHex },
  // Pause positives (20 verified tokens).
  { power: "pause", cls: "getter-helper gate, internal writers", tokens: 8, label: true, hex: boolHelperPauseTokenHex },
  { power: "pause", cls: "getter-helper gate from update", tokens: 1, label: true, hex: boolHelperPauseTokenHex },
  { power: "pause", cls: "packed flag bit beside other data", tokens: 7, label: true, hex: packedSlotPauseTokenHex },
  { power: "pause", cls: "reversible trading toggle with exemption", tokens: 3, label: true, hex: () => tradingToggleExemptTokenHex(true) },
  { power: "pause", cls: "pair-only flag gate", tokens: 1, label: true, hex: pairOnlyPauseTokenHex },
  // Pause negatives (14 verified tokens).
  { power: "pause", cls: "one-way trading enable", tokens: 13, label: false, hex: () => tradingToggleExemptTokenHex(false) },
  { power: "pause", cls: "no pause power (blacklist-only token)", tokens: 1, label: false, hex: customErrorBlacklistTokenHex },
  // Fee positives (15 verified tokens); receiver-share mapping class excluded below.
  { power: "fee", cls: "packed fee-struct setter", tokens: 2, label: true, hex: packedStructFeeTokenHex },
  { power: "fee", cls: "dual-rate setter with cap", tokens: 10, label: true, hex: dualRateFeeTokenHex },
  { power: "fee", cls: "internal fee setter helper", tokens: 1, label: true, hex: internalSetterFeeTokenHex },
  { power: "fee", cls: "array-element fee shares", tokens: 2, label: true, hex: arrayShareFeeTokenHex },
  // Fee negative (representative no-fee token).
  { power: "fee", cls: "no fee power (pause-only token)", tokens: 19, label: false, hex: boolHelperPauseTokenHex },
  // Limits positives (17 verified tokens).
  { power: "limits", cls: "scaled limit setter, shared gate", tokens: 14, label: true, hex: scaledLimitTokenHex },
  { power: "limits", cls: "anti-whale struct setter", tokens: 3, label: true, hex: antiWhaleLimitTokenHex },
  // Limits negative: the snipe-window false-positive class.
  { power: "limits", cls: "block-number snipe window", tokens: 1, label: false, hex: snipeWindowLimitTokenHex },
  // Mint positives (12 verified tokens).
  { power: "mint", cls: "stored-recipient issue", tokens: 7, label: true, hex: storedRecipientMintTokenHex },
  { power: "mint", cls: "internal mint helper", tokens: 5, label: true, hex: internalMintTokenHex },
  // Mint negatives: burn shapes.
  { power: "mint", cls: "burn through shared update helper", tokens: 1, label: false, hex: burnThroughUpdateTokenHex },
];

function measure(power: Power): { tp: number; fp: number; fn: number; tn: number } {
  let tp = 0;
  let fp = 0;
  let fn = 0;
  let tn = 0;
  for (const row of CLASSES) {
    if (row.power !== power) {
      continue;
    }
    const found = detect(power, row.hex());
    // One synthetic fixture class counts once, regardless of how many
    // real tokens were assigned to the class.
    if (row.label && found) {
      tp += 1;
    } else if (row.label) {
      fn += 1;
    } else if (found) {
      fp += 1;
    } else {
      tn += 1;
    }
  }
  return { tp, fp, fn, tn };
}

describe("SCAN-4 synthetic fixture measurement (per class, unweighted)", () => {
  test("blacklist synthetic classes: getter-helper class is a known miss", () => {
    const result = measure("blacklist");
    console.log(`blacklist synthetic classes TP=${result.tp} FP=${result.fp} FN=${result.fn} TN=${result.tn}`);
    expect(result).toEqual({ tp: 7, fp: 0, fn: 1, tn: 3 });
  });

  test("pause synthetic classes: getter-helper classes are known misses", () => {
    const result = measure("pause");
    console.log(`pause synthetic classes TP=${result.tp} FP=${result.fp} FN=${result.fn} TN=${result.tn}`);
    expect(result).toEqual({ tp: 3, fp: 0, fn: 2, tn: 2 });
  });

  test("limits synthetic classes report no FP or FN", () => {
    const result = measure("limits");
    console.log(`limits synthetic classes TP=${result.tp} FP=${result.fp} FN=${result.fn} TN=${result.tn}`);
    expect(result).toEqual({ tp: 2, fp: 0, fn: 0, tn: 1 });
  });

  test("mint synthetic classes report no FP or FN", () => {
    const result = measure("mint");
    console.log(`mint synthetic classes TP=${result.tp} FP=${result.fp} FN=${result.fn} TN=${result.tn}`);
    expect(result).toEqual({ tp: 2, fp: 0, fn: 0, tn: 1 });
  });

  test("fee synthetic classes report no FP or FN", () => {
    const result = measure("fee");
    console.log(`fees synthetic classes TP=${result.tp} FP=${result.fp} FN=${result.fn} TN=${result.tn}`);
    expect(result).toEqual({ tp: 4, fp: 0, fn: 0, tn: 1 });
  });
});
