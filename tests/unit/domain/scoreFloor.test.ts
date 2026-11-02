// Tests for SCORE-1: the deterministic evidence-based score floor.
// The calibrated score stands unless proven owner powers floor it:
// block-holder powers at 60 (High), other risky owner powers at 30
// (Elevated), proven renounced ownership at nothing. The floor never
// lowers a score and never moves the calibrated probabilities.
import { describe, expect, test } from "vitest";
import { Evidence } from "../../../src/domain/evidence.ts";
import type { Evidence as EvidenceType, NonEmpty } from "../../../src/domain/evidence.ts";
import { parseModelArtifact, score } from "../../../src/domain/risk.ts";
import type { ModelArtifact } from "../../../src/domain/risk.ts";
import {
  applyScoreFloor,
  floorFactsFromSignals,
  scoreBandWord,
} from "../../../src/domain/scoreFloor.ts";
import type { ScoreFloorFacts } from "../../../src/domain/scoreFloor.ts";
import { Signal } from "../../../src/domain/signals.ts";
import type { Signal as SignalType } from "../../../src/domain/signals.ts";
import { Bytecode, CodeHash, Selector } from "../../../src/domain/types.ts";
import type { CodeHash as CodeHashType } from "../../../src/domain/types.ts";
import type { Result } from "../../../src/domain/result.ts";

function mustOk<T, E extends { message: string }>(result: Result<T, E>): T {
  if (!result.ok) {
    throw new Error(`expected ok, got error: ${result.error.message}`);
  }
  return result.value;
}

function facts(partial: Partial<ScoreFloorFacts>): ScoreFloorFacts {
  return Object.freeze({
    block: partial.block ?? [],
    risky: partial.risky ?? [],
    renouncedProven: partial.renouncedProven ?? false,
  });
}

describe("score floor branches (SCORE-1)", () => {
  test("floor_block_holder_facts_reach_high", () => {
    for (const fact of ["blacklist", "pause", "sell-block"]) {
      const floored = applyScoreFloor(29, facts({ block: [fact] }));
      expect(floored.score as number).toBe(60);
      expect(floored.floor?.rule).toBe("owner-can-block-holders");
      expect(floored.floor?.minimum).toBe(60);
      expect(floored.floor?.label).toBe(`floor: owner can block holders (${fact})`);
      expect(scoreBandWord(floored.score as number)).toBe("High");
    }
  });

  test("floor_blacklist_and_pause_label_names_both", () => {
    const floored = applyScoreFloor(29, facts({ block: ["pause", "blacklist"] }));
    expect(floored.score as number).toBe(60);
    expect(floored.floor?.label).toBe("floor: owner can block holders (blacklist, pause)");
  });

  test("floor_risky_capabilities_reach_elevated", () => {
    for (const fact of ["mint", "transfer-fee", "transfer-limits", "proxy-upgrade"]) {
      const floored = applyScoreFloor(19, facts({ risky: [fact] }));
      expect(floored.score as number).toBe(30);
      expect(floored.floor?.rule).toBe("owner-risky-capability");
      expect(floored.floor?.minimum).toBe(30);
      expect(scoreBandWord(floored.score as number)).toBe("Elevated");
    }
  });

  test("floor_block_beats_risky", () => {
    const floored = applyScoreFloor(10, facts({ block: ["pause"], risky: ["mint"] }));
    expect(floored.score as number).toBe(60);
    expect(floored.floor?.rule).toBe("owner-can-block-holders");
  });

  test("floor_renounced_proven_means_no_floor", () => {
    const floored = applyScoreFloor(
      29,
      facts({ block: ["blacklist", "pause"], risky: ["mint"], renouncedProven: true }),
    );
    expect(floored.score as number).toBe(29);
    expect(floored.floor).toBeNull();
    expect(scoreBandWord(floored.score as number)).toBe("Low");
  });

  test("floor_never_lowers_a_score", () => {
    const high = applyScoreFloor(80, facts({ block: ["blacklist"] }));
    expect(high.score as number).toBe(80);
    expect(high.floor?.minimum).toBe(60);
    const mid = applyScoreFloor(45, facts({ risky: ["mint"] }));
    expect(mid.score as number).toBe(45);
    expect(mid.floor?.minimum).toBe(30);
  });

  test("floor_no_proven_power_stands", () => {
    const floored = applyScoreFloor(29, facts({}));
    expect(floored.score as number).toBe(29);
    expect(floored.floor).toBeNull();
  });

  test("floor_unknown_facts_prove_nothing", () => {
    const floored = applyScoreFloor(12, facts({ block: ["owner-slot"], risky: ["transfer-hooks"] }));
    expect(floored.score as number).toBe(12);
    expect(floored.floor).toBeNull();
  });

  test("floor_band_words_follow_the_documented_edges", () => {
    expect(scoreBandWord(0)).toBe("Low");
    expect(scoreBandWord(29)).toBe("Low");
    expect(scoreBandWord(30)).toBe("Elevated");
    expect(scoreBandWord(59)).toBe("Elevated");
    expect(scoreBandWord(60)).toBe("High");
    expect(scoreBandWord(100)).toBe("High");
  });
});

// Integration with score(): proven blacklist + pause signals under an
// active (not renounced) owner floor the served score while the
// calibrated probabilities and calibrated score stay untouched.
const CODE_HASH: CodeHashType = mustOk(CodeHash.of(mustOk(Bytecode.parse("0x600160005506"))));

function evidenceFor(selectorRaw: string): EvidenceType {
  return mustOk(Evidence.create({ selector: mustOk(Selector.parse(selectorRaw)) }));
}

function syntheticArtifact(): ModelArtifact {
  return mustOk(
    parseModelArtifact({
      version: "0.0.0-synthetic.9",
      severityWeights: { low: 0.25, medium: 0.5, high: 1.0 },
      causeWeights: {
        timeout: 0.2,
        "resource-limit": 0.2,
        "decompiler-error": 0.3,
        "obfuscated-structure": 0.4,
      },
      biases: { "rug-pull": -0.5, honeypot: -1.0, "bot-pump": -1.5 },
      calibration: {
        "rug-pull": { slope: 1.0, intercept: 0.0 },
        honeypot: { slope: 1.0, intercept: 0.0 },
        "bot-pump": { slope: 1.0, intercept: 0.0 },
      },
      scoreWeights: { "rug-pull": 0.5, honeypot: 0.3, "bot-pump": 0.2 },
    }),
  );
}

function ownerSignal(plugin: string, selectorRaw: string): SignalType {
  return mustOk(
    Signal.createCapability({
      codeHash: CODE_HASH,
      risk: "honeypot",
      direction: "raises",
      severity: "high",
      temporality: { kind: "can-change-unknown" },
      evidence: [evidenceFor(selectorRaw)] as unknown as NonEmpty<EvidenceType>,
      sourcePlugin: plugin,
    }),
  );
}

describe("score floor through score() (SCORE-1)", () => {
  test("floor_proven_blacklist_pause_active_owner_scores_high_probabilities_unchanged", () => {
    const artifact = syntheticArtifact();
    const signals = [
      ownerSignal("dev.brandklipparen.blacklist", "0xa9059cbb"),
      ownerSignal("dev.brandklipparen.pause", "0x095ea7b3"),
    ];
    const floored = score(signals, artifact);
    const renounced = score(signals, artifact, facts({ block: ["blacklist", "pause"], renouncedProven: true }));
    expect(floored.score as number).toBeGreaterThanOrEqual(60);
    expect(scoreBandWord(floored.score as number)).toBe("High");
    expect(floored.floor?.label).toBe("floor: owner can block holders (blacklist, pause)");
    // Calibrated side untouched: same probabilities, same calibrated
    // score, and the renounced run serves exactly that calibrated score.
    expect(floored.probabilities).toEqual(renounced.probabilities);
    expect(floored.calibratedScore).toEqual(renounced.score);
    expect(renounced.floor).toBeNull();
  });

  test("floor_facts_from_signals_names_only_owner_powers", () => {
    const derived = floorFactsFromSignals([
      ownerSignal("dev.brandklipparen.mint", "0x40c10f19"),
      ownerSignal("dev.brandklipparen.capability", "0x70a08231"),
    ]);
    expect(derived.risky).toEqual(["mint"]);
    expect(derived.block).toEqual([]);
    expect(derived.renouncedProven).toBe(false);
  });
});
