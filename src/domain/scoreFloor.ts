// Deterministic evidence-based score floor (SCORE-1).
// Pure domain module: no I/O, no clock, no learned numbers. The calibrated
// model (artifact 1.0.1, AUC about 0.55) caps near 29 even when every
// detector fires, so its band contradicted proven owner powers on the same
// page. This floor runs after the calibrated score and only ever raises
// it: proven owner powers that can stop holders moving tokens floor at
// the High cutoff (60), other proven owner-risky capabilities floor at
// the Elevated cutoff (30), and proven renounced ownership floors at
// nothing. The cutoffs are the documented band edges (0-29 Low, 30-59
// Elevated, 60-100 High), not model values, so they live here as named
// constants beside the rule that uses them.
import { RiskScore } from "./types.ts";
import type { RiskScore as RiskScoreType } from "./types.ts";
import type { Signal } from "./signals.ts";

export const SCORE_FLOOR_HIGH = 60;
export const SCORE_FLOOR_ELEVATED = 30;

// Proven facts that let the owner stop holders selling or moving tokens.
export const BLOCK_HOLDER_FACTS: readonly string[] = Object.freeze(["blacklist", "pause", "sell-block"]);

// Proven owner-risky capabilities that do not by themselves block holders.
export const RISKY_FACTS: readonly string[] = Object.freeze([
  "mint",
  "transfer-fee",
  "transfer-limits",
  "proxy-upgrade",
]);

// Detector plugin id to the floor fact its scored signals prove. Only
// owner-power detectors appear; every other plugin proves no floor fact.
const PLUGIN_FACT: Readonly<Record<string, string>> = Object.freeze({
  "dev.brandklipparen.blacklist": "blacklist",
  "dev.brandklipparen.pause": "pause",
  "dev.brandklipparen.sell-block": "sell-block",
  "dev.brandklipparen.mint": "mint",
  "dev.brandklipparen.transfer-fee": "transfer-fee",
  "dev.brandklipparen.transfer-limits": "transfer-limits",
  "dev.brandklipparen.proxy-upgrade": "proxy-upgrade",
});

export type ScoreFloorFacts = {
  readonly block: readonly string[];
  readonly risky: readonly string[];
  readonly renouncedProven: boolean;
};

export type AppliedScoreFloor = {
  readonly rule: "owner-can-block-holders" | "owner-risky-capability";
  readonly minimum: number;
  readonly label: string;
  readonly facts: readonly string[];
};

export type FlooredScore = {
  readonly score: RiskScoreType;
  readonly floor: AppliedScoreFloor | null;
};

function orderedPresent(known: readonly string[], present: ReadonlySet<string>): string[] {
  return known.filter((fact) => present.has(fact));
}

function toScore(value: number): RiskScoreType {
  const clamped = Math.min(100, Math.max(0, Math.round(value)));
  const parsed = RiskScore.of(clamped);
  return parsed.ok ? parsed.value : (0 as RiskScoreType);
}

// Floor facts proved by scored signals alone: a capability signal whose
// source plugin is an owner-power detector. Renounced ownership is never
// proved by signals, so callers with live ownership evidence pass facts
// explicitly instead. Unknown plugins and fact-less signals prove nothing.
export function floorFactsFromSignals(signals: readonly Signal[]): ScoreFloorFacts {
  const block = new Set<string>();
  const risky = new Set<string>();
  for (const signal of signals) {
    if (signal.kind !== "capability" || signal.sourcePlugin === undefined) {
      continue;
    }
    const fact = PLUGIN_FACT[signal.sourcePlugin];
    if (fact === undefined) {
      continue;
    }
    if (BLOCK_HOLDER_FACTS.includes(fact)) {
      block.add(fact);
    } else {
      risky.add(fact);
    }
  }
  return Object.freeze({
    block: Object.freeze(orderedPresent(BLOCK_HOLDER_FACTS, block)),
    risky: Object.freeze(orderedPresent(RISKY_FACTS, risky)),
    renouncedProven: false,
  });
}

// The floor itself: deterministic and explainable. Proven renounced
// ownership removes every floor. Otherwise a proven block-holder fact
// floors at High, else a proven risky capability floors at Elevated,
// else the calibrated score stands. The result never lowers the input.
export function applyScoreFloor(calibratedScore: number, facts: ScoreFloorFacts): FlooredScore {
  const calibrated = toScore(calibratedScore);
  if (facts.renouncedProven) {
    return Object.freeze({ score: calibrated, floor: null });
  }
  const block = orderedPresent(BLOCK_HOLDER_FACTS, new Set(facts.block));
  if (block.length > 0) {
    const floor: AppliedScoreFloor = Object.freeze({
      rule: "owner-can-block-holders",
      minimum: SCORE_FLOOR_HIGH,
      label: `floor: owner can block holders (${block.join(", ")})`,
      facts: Object.freeze(block),
    });
    return Object.freeze({
      score: toScore(Math.max(calibrated as number, SCORE_FLOOR_HIGH)),
      floor: Object.freeze(floor),
    });
  }
  const risky = orderedPresent(RISKY_FACTS, new Set(facts.risky));
  if (risky.length > 0) {
    const floor: AppliedScoreFloor = Object.freeze({
      rule: "owner-risky-capability",
      minimum: SCORE_FLOOR_ELEVATED,
      label: `floor: owner has risky capability (${risky.join(", ")})`,
      facts: Object.freeze(risky),
    });
    return Object.freeze({
      score: toScore(Math.max(calibrated as number, SCORE_FLOOR_ELEVATED)),
      floor: Object.freeze(floor),
    });
  }
  return Object.freeze({ score: calibrated, floor: null });
}

// Band word for a (possibly floored) score on the documented scale.
export function scoreBandWord(score: number): "Low" | "Elevated" | "High" {
  if (score >= SCORE_FLOOR_HIGH) {
    return "High";
  }
  if (score >= SCORE_FLOOR_ELEVATED) {
    return "Elevated";
  }
  return "Low";
}
