// Tests for S-020 (K-011): calibrated probabilities and 0-100 score from signals.
// Written first (red) per A-21; the implementation lives in src/domain/risk.ts.
// Every artifact below is a small synthetic placeholder for the tests only:
// version "0.0.0-synthetic.N", hand-picked numbers with no predictive meaning.
// Production values come from the versioned model artifact per K-210 and A-20,
// and no production artifact is committed. No thresholds, weights or limits
// live in src: score() reads every model value from the artifact parameter.
import { describe, expect, test } from "vitest";
import * as fc from "fast-check";
import { Evidence } from "../../../src/domain/evidence.ts";
import type { NonEmpty } from "../../../src/domain/evidence.ts";
import type { Evidence as EvidenceType } from "../../../src/domain/evidence.ts";
import { parseModelArtifact, score } from "../../../src/domain/risk.ts";
import type { ModelArtifact, RiskResult } from "../../../src/domain/risk.ts";
import { Signal } from "../../../src/domain/signals.ts";
import type { Signal as SignalType } from "../../../src/domain/signals.ts";
import type {
  Direction as DirectionType,
  RiskType as RiskTypeAlias,
  Severity as SeverityType,
} from "../../../src/domain/signals.ts";
import type { HardToAnalyzeCause } from "../../../src/domain/signals.ts";
import {
  Address,
  Bytecode,
  CloneGroupId,
  CodeHash,
  Probability,
  Selector,
} from "../../../src/domain/types.ts";
import type { CodeHash as CodeHashType } from "../../../src/domain/types.ts";
import type { Result } from "../../../src/domain/result.ts";

// Unwrap a Result in tests only; the domain itself never throws.
function mustOk<T, E extends { message: string }>(result: Result<T, E>): T {
  if (!result.ok) {
    throw new Error(`expected ok, got error: ${result.error.message}`);
  }
  return result.value;
}

// Synthetic placeholder artifact for the tests only. Production values come
// from the versioned model artifact per K-210 and A-20.
function syntheticArtifactJson(version: string): unknown {
  return {
    version,
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
  };
}

function mustArtifact(version: string): ModelArtifact {
  return mustOk(parseModelArtifact(syntheticArtifactJson(version)));
}

const CODE_HASH: CodeHashType = mustOk(CodeHash.of(mustOk(Bytecode.parse("0x600160005506"))));

const CHANGER = mustOk(Address.parse("0x0102030405060708090a0b0c0d0e0f1011121314"));

const SELECTOR_POOL = ["0xa9059cbb", "0x70a08231", "0x18160ddd", "0x095ea7b3"] as const;

function evidenceFor(selectorRaw: string): EvidenceType {
  return mustOk(Evidence.create({ selector: mustOk(Selector.parse(selectorRaw)) }));
}

const RISKS = ["rug-pull", "honeypot", "bot-pump"] as const;
const DIRECTIONS = ["raises", "lowers"] as const;
const SEVERITIES = ["low", "medium", "high"] as const;
const CAUSES = ["timeout", "resource-limit", "decompiler-error", "obfuscated-structure"] as const;

function capabilitySignal(
  risk: RiskTypeAlias,
  direction: DirectionType,
  severity: SeverityType,
  selectorRaw: string,
): SignalType {
  return mustOk(
    Signal.createCapability({
      codeHash: CODE_HASH,
      risk,
      direction,
      severity,
      temporality: { kind: "can-change", changer: CHANGER },
      evidence: [evidenceFor(selectorRaw)] as unknown as NonEmpty<EvidenceType>,
    }),
  );
}

function anySignalArb(): fc.Arbitrary<SignalType> {
  return fc
    .tuple(
      fc.constantFrom(...RISKS),
      fc.constantFrom(...DIRECTIONS),
      fc.constantFrom(...SEVERITIES),
      fc.constantFrom(...SELECTOR_POOL),
      fc.constantFrom(...CAUSES),
      fc.double({ min: 0, max: 1, noNaN: true }),
      fc.integer({ min: 0, max: 25 }),
      fc.integer({ min: 0, max: 2 }),
    )
    .map(([risk, direction, severity, selectorRaw, cause, similarityRaw, priorCount, kind]) => {
      const evidence = [evidenceFor(selectorRaw)] as unknown as NonEmpty<EvidenceType>;
      if (kind === 0) {
        return capabilitySignal(risk, direction, severity, selectorRaw);
      }
      if (kind === 1) {
        return mustOk(
          Signal.createCloneMatch({
            codeHash: CODE_HASH,
            risk,
            direction,
            severity,
            similarity: mustOk(Probability.ofRounded(similarityRaw)),
            group: mustOk(CloneGroupId.parse("synthetic-trap-group")),
            priorCount,
            evidence,
          }),
        );
      }
      return mustOk(
        Signal.createHardToAnalyze({
          codeHash: CODE_HASH,
          risk,
          cause: cause as HardToAnalyzeCause,
          evidence,
        }),
      );
    });
}

function finiteNumberArb(): fc.Arbitrary<number> {
  return fc.double({ min: -50, max: 50, noNaN: true }).filter((value) => Number.isFinite(value));
}

function artifactJsonArb(): fc.Arbitrary<unknown> {
  return fc
    .tuple(
      fc.constantFrom("0.0.0-synthetic.1", "0.0.0-synthetic.2"),
      finiteNumberArb(),
      finiteNumberArb(),
      finiteNumberArb(),
      finiteNumberArb(),
      finiteNumberArb(),
      finiteNumberArb(),
      finiteNumberArb(),
      finiteNumberArb(),
      finiteNumberArb(),
    )
    .map(
      ([
        version,
        low,
        medium,
        high,
        timeoutWeight,
        biasRp,
        biasHp,
        biasBp,
        slope,
        intercept,
      ]) => ({
        version,
        severityWeights: { low, medium, high },
        causeWeights: {
          timeout: timeoutWeight,
          "resource-limit": timeoutWeight,
          "decompiler-error": timeoutWeight,
          "obfuscated-structure": timeoutWeight,
        },
        biases: { "rug-pull": biasRp, honeypot: biasHp, "bot-pump": biasBp },
        calibration: {
          "rug-pull": { slope, intercept },
          honeypot: { slope, intercept },
          "bot-pump": { slope, intercept },
        },
        scoreWeights: { "rug-pull": low, honeypot: medium, "bot-pump": high },
      }),
    );
}

describe("k011 risk model from signals and artifact", () => {
  test("k011_probabilities_in_unit_interval_and_integer_score", () => {
    fc.assert(
      fc.property(artifactJsonArb(), fc.array(anySignalArb(), { maxLength: 6 }), (json, signals) => {
        const artifact = mustOk(parseModelArtifact(json));
        const before = JSON.stringify(signals);
        const first = score(signals, artifact);
        const reversed = score([...signals].reverse(), artifact);
        const rerun = score(signals, artifact);

        // Probabilities lie in [0, 1] and the score is an integer in [0, 100].
        const probabilities: readonly number[] = [
          first.probabilities["rug-pull"] as number,
          first.probabilities["honeypot"] as number,
          first.probabilities["bot-pump"] as number,
        ];
        for (const value of probabilities) {
          expect(value).toBeGreaterThanOrEqual(0);
          expect(value).toBeLessThanOrEqual(1);
          expect(Number.isFinite(value)).toBe(true);
        }
        expect(Number.isInteger(first.score as number)).toBe(true);
        expect(first.score as number).toBeGreaterThanOrEqual(0);
        expect(first.score as number).toBeLessThanOrEqual(100);

        // Deterministic: repeated runs agree bit for bit.
        expect(rerun).toEqual(first);
        // Independent of signal input order: the canonical order steers.
        expect(reversed).toEqual(first);

        // The result records the artifact version for reproducibility.
        expect(first.modelVersion as string).toBe(artifact.version as string);

        // The analysis leaves its inputs unchanged.
        expect(JSON.stringify(signals)).toBe(before);
      }),
      { seed: 110201, numRuns: 300 },
    );
  });

  test("k011_malformed_artifact_rejected_with_typed_error", () => {
    const malformed: ReadonlyArray<readonly [string, unknown]> = [
      ["null input", null],
      ["string input", "0.0.0-synthetic.1"],
      ["array input", []],
      ["missing version", { ...((syntheticArtifactJson("0.0.0-synthetic.1") as Record<string, unknown>)), version: undefined }],
      ["bad semver version", syntheticArtifactJson("1.2")],
      ["numeric version", { ...(syntheticArtifactJson("0.0.0-synthetic.1") as Record<string, unknown>), version: 1 }],
      ["missing severity weights", { ...(syntheticArtifactJson("0.0.0-synthetic.1") as Record<string, unknown>), severityWeights: undefined }],
      ["NaN severity weight", { ...(syntheticArtifactJson("0.0.0-synthetic.1") as Record<string, unknown>), severityWeights: { low: Number.NaN, medium: 0.5, high: 1.0 } }],
      ["infinite calibration slope", { ...(syntheticArtifactJson("0.0.0-synthetic.1") as Record<string, unknown>), calibration: { "rug-pull": { slope: Number.POSITIVE_INFINITY, intercept: 0 }, honeypot: { slope: 1, intercept: 0 }, "bot-pump": { slope: 1, intercept: 0 } } }],
      ["missing calibration entry", { ...(syntheticArtifactJson("0.0.0-synthetic.1") as Record<string, unknown>), calibration: { "rug-pull": { slope: 1, intercept: 0 } } }],
      ["string score weight", { ...(syntheticArtifactJson("0.0.0-synthetic.1") as Record<string, unknown>), scoreWeights: { "rug-pull": "high", honeypot: 0.3, "bot-pump": 0.2 } }],
      ["missing cause weight", { ...(syntheticArtifactJson("0.0.0-synthetic.1") as Record<string, unknown>), causeWeights: { timeout: 0.2 } }],
      ["unknown top-level key", { ...(syntheticArtifactJson("0.0.0-synthetic.1") as Record<string, unknown>), thresholds: { low: 1 } }],
    ];
    for (const [name, input] of malformed) {
      const parsed = parseModelArtifact(input);
      expect(parsed.ok, name).toBe(false);
      if (!parsed.ok) {
        expect(parsed.error.kind).toBe("invalid-model-artifact");
      }
    }
  });

  test("k011_result_records_artifact_version", () => {
    const first = score([], mustArtifact("0.0.0-synthetic.1"));
    const second = score([], mustArtifact("0.0.0-synthetic.2"));
    expect(first.modelVersion as string).toBe("0.0.0-synthetic.1");
    expect(second.modelVersion as string).toBe("0.0.0-synthetic.2");
  });

  test("k011_weights_loaded_from_versioned_artifact_only", () => {
    const signals: readonly SignalType[] = [
      capabilitySignal("rug-pull", "raises", "high", "0xa9059cbb"),
    ];
    const light = mustArtifact("0.0.0-synthetic.1");
    const heavyJson = syntheticArtifactJson("0.0.0-synthetic.2") as Record<string, unknown>;
    (heavyJson["severityWeights"] as Record<string, unknown>)["high"] = 5.0;
    const heavy = mustOk(parseModelArtifact(heavyJson));
    const lightResult: RiskResult = score(signals, light);
    const heavyResult: RiskResult = score(signals, heavy);
    // The same signals give different probabilities under different artifacts,
    // so the response follows the artifact and no hardcoded weight steers it.
    expect(heavyResult.probabilities["rug-pull"] as number).toBeGreaterThan(
      lightResult.probabilities["rug-pull"] as number,
    );
    expect(heavyResult.modelVersion as string).toBe("0.0.0-synthetic.2");
  });

  test("k011_calibrated_head_weights_steer_sourced_signals", () => {
    const base = syntheticArtifactJson("0.0.0-synthetic.1") as Record<string, unknown>;
    base["detectorHeadWeights"] = {
      "dev.brandklipparen.mint": { "rug-pull": 2.0, honeypot: 0.0 },
    };
    const artifact = mustOk(parseModelArtifact(base));
    const sourced = mustOk(
      Signal.createCapability({
        codeHash: CODE_HASH,
        risk: "rug-pull",
        direction: "raises",
        severity: "low",
        temporality: { kind: "can-change", changer: CHANGER },
        evidence: [evidenceFor("0xa9059cbb")] as unknown as NonEmpty<EvidenceType>,
        sourcePlugin: "dev.brandklipparen.mint",
      }),
    );
    const unsourced = capabilitySignal("rug-pull", "raises", "low", "0x70a08231");
    const sourcedResult = score([sourced], artifact);
    const unsourcedResult = score([unsourced], artifact);
    // The sourced signal scores with the head weight 2.0, not the low
    // severity weight 0.25, so its contribution and probability exceed the
    // severity path.
    expect(sourcedResult.contributions[0]?.weight).toBe(2.0);
    // C-15: the sourced signal fans out to both fitted heads; honeypot 0 contributes 0.
    expect(
      sourcedResult.contributions.find((entry) => entry.risk === "honeypot")?.weight,
    ).toBe(0);
    expect(unsourcedResult.contributions[0]?.weight).toBe(0.25);
    expect(sourcedResult.probabilities["rug-pull"] as number).toBeGreaterThan(
      unsourcedResult.probabilities["rug-pull"] as number,
    );
  });

  test("k011_head_weights_reject_negatives_and_unknown_shapes", () => {
    const negative = syntheticArtifactJson("0.0.0-synthetic.1") as Record<string, unknown>;
    negative["detectorHeadWeights"] = {
      "dev.brandklipparen.mint": { "rug-pull": -0.5, honeypot: 0.0 },
    };
    expect(parseModelArtifact(negative).ok).toBe(false);
    const missing = syntheticArtifactJson("0.0.0-synthetic.1") as Record<string, unknown>;
    missing["detectorHeadWeights"] = {
      "dev.brandklipparen.mint": { "rug-pull": 1.0 },
    };
    expect(parseModelArtifact(missing).ok).toBe(false);
    const uncalibrated = syntheticArtifactJson("0.0.0-synthetic.1") as Record<string, unknown>;
    uncalibrated["detectorHeadWeights"] = {};
    expect(parseModelArtifact(uncalibrated).ok).toBe(true);
  });

  test("k011_response_names_model_version_and_top_contributors", () => {
    const signals: readonly SignalType[] = [
      capabilitySignal("rug-pull", "raises", "high", "0xa9059cbb"),
      capabilitySignal("honeypot", "lowers", "low", "0x70a08231"),
    ];
    const result: RiskResult = score(signals, mustArtifact("0.0.0-synthetic.1"));
    expect(result.modelVersion as string).toBe("0.0.0-synthetic.1");
    expect(result.contributions.length).toBe(2);
    // Contributions sort by descending absolute weight, so the high-severity
    // raising signal contributes most.
    expect(result.contributions[0]?.direction).toBe("raises");
    expect(result.contributions[0]?.risk).toBe("rug-pull");
    const raising = result.contributions.filter((entry) => entry.direction === "raises");
    const lowering = result.contributions.filter((entry) => entry.direction === "lowers");
    expect(raising.length).toBe(1);
    expect(lowering.length).toBe(1);
  });
});
