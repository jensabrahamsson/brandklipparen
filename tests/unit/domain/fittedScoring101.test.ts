// C-15 (F-8): production scoring equals the fitted model on artifact
// 1.0.1. One indicator per plugin, applied to every fitted head, counted
// once. Probabilities are asserted, not the integer score (N-2).
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import * as fc from "fast-check";
import { Evidence } from "../../../src/domain/evidence.ts";
import type { Evidence as EvidenceType, NonEmpty } from "../../../src/domain/evidence.ts";
import { isFeaturePayload, parseModelArtifact, score } from "../../../src/domain/risk.ts";
import type { ModelArtifact, RiskResult } from "../../../src/domain/risk.ts";
import { Signal } from "../../../src/domain/signals.ts";
import type { Signal as SignalType } from "../../../src/domain/signals.ts";
import { Bytecode, CodeHash, Selector } from "../../../src/domain/types.ts";
import type { CodeHash as CodeHashType } from "../../../src/domain/types.ts";
import type { Result } from "../../../src/domain/result.ts";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..", "..");

function mustOk<T, E extends { message: string }>(result: Result<T, E>): T {
  if (!result.ok) {
    throw new Error(`expected ok, got error: ${result.error.message}`);
  }
  return result.value;
}

function artifact101(): ModelArtifact {
  const raw = JSON.parse(readFileSync(join(repoRoot, "model", "artifact-1.0.1.json"), "utf8")) as {
    artifact: unknown;
  };
  return mustOk(parseModelArtifact(raw.artifact));
}

const CODE_HASH: CodeHashType = mustOk(CodeHash.of(mustOk(Bytecode.parse("0x600160005506"))));

function evidenceFor(selectorRaw: string): EvidenceType {
  return mustOk(Evidence.create({ selector: mustOk(Selector.parse(selectorRaw)) }));
}

function fittedSignal(
  plugin: string,
  risk: "rug-pull" | "honeypot",
  severity: "low" | "medium" | "high",
  selectorRaw: string,
): SignalType {
  return mustOk(
    Signal.createCapability({
      codeHash: CODE_HASH,
      risk,
      direction: "raises",
      severity,
      temporality: { kind: "can-change-unknown" },
      evidence: [evidenceFor(selectorRaw)] as unknown as NonEmpty<EvidenceType>,
      sourcePlugin: plugin,
    }),
  );
}

// Catalogue risk/severity per plugin in artifact 1.0.1, with a distinct
// synthetic selector per plugin.
const PLUGINS: readonly {
  readonly plugin: string;
  readonly risk: "rug-pull" | "honeypot";
  readonly severity: "low" | "medium" | "high";
  readonly selector: string;
  readonly pRug: number;
  readonly pHoney: number;
  readonly score: number;
}[] = [
  { plugin: "dev.brandklipparen.blacklist", risk: "honeypot", severity: "high", selector: "0xa9059cbb", pRug: 0.259527, pHoney: 0.132546, score: 21 },
  { plugin: "dev.brandklipparen.mint", risk: "rug-pull", severity: "high", selector: "0x70a08231", pRug: 0.268405, pHoney: 0.082916, score: 20 },
  { plugin: "dev.brandklipparen.ownership", risk: "rug-pull", severity: "medium", selector: "0x18160ddd", pRug: 0.347531, pHoney: 0.103419, score: 24 },
  { plugin: "dev.brandklipparen.pause", risk: "honeypot", severity: "high", selector: "0x095ea7b3", pRug: 0.264278, pHoney: 0.082916, score: 19 },
  { plugin: "dev.brandklipparen.sell-block", risk: "honeypot", severity: "high", selector: "0x23b872dd", pRug: 0.268867, pHoney: 0.082916, score: 20 },
  { plugin: "dev.brandklipparen.transfer-fee", risk: "honeypot", severity: "medium", selector: "0xdd62ed3e", pRug: 0.259527, pHoney: 0.082916, score: 19 },
  { plugin: "dev.brandklipparen.transfer-hooks", risk: "honeypot", severity: "medium", selector: "0x06fdde03", pRug: 0.27901, pHoney: 0.082916, score: 20 },
  { plugin: "dev.brandklipparen.transfer-limits", risk: "honeypot", severity: "medium", selector: "0x95d89b41", pRug: 0.275991, pHoney: 0.082916, score: 20 },
  { plugin: "dev.brandklipparen.proxy-upgrade", risk: "rug-pull", severity: "high", selector: "0x8da5cb5b", pRug: 0.259527, pHoney: 0.082916, score: 19 },
];

describe("c15 fitted scoring on 1.0.1", () => {
  test("c15_baseline_is_19", () => {
    const result: RiskResult = score([], artifact101());
    expect(result.probabilities["rug-pull"] as number).toBe(0.259527);
    expect(result.probabilities["honeypot"] as number).toBe(0.082916);
    expect(result.score as number).toBe(19);
  });

  for (const entry of PLUGINS) {
    test(`c15_${entry.plugin.split(".").pop()}_moves_every_fitted_head`, () => {
      const artifact = artifact101();
      const baseline = score([], artifact);
      const result = score(
        [fittedSignal(entry.plugin, entry.risk, entry.severity, entry.selector)],
        artifact,
      );
      expect(result.probabilities["rug-pull"] as number).toBe(entry.pRug);
      expect(result.probabilities["honeypot"] as number).toBe(entry.pHoney);
      expect(result.score as number).toBe(entry.score);
      // A head with fitted weight 0 stays at baseline; a non-zero head moves.
      const weights = artifact.detectorHeadWeights?.[entry.plugin];
      if ((weights?.["rug-pull"] ?? 0) === 0) {
        expect(result.probabilities["rug-pull"]).toBe(baseline.probabilities["rug-pull"]);
      } else {
        expect(result.probabilities["rug-pull"] as number).not.toBe(
          baseline.probabilities["rug-pull"] as number,
        );
      }
      if ((weights?.["honeypot"] ?? 0) === 0) {
        expect(result.probabilities["honeypot"]).toBe(baseline.probabilities["honeypot"]);
      } else {
        expect(result.probabilities["honeypot"] as number).not.toBe(
          baseline.probabilities["honeypot"] as number,
        );
      }
      // One representative signal fans out to exactly two contributions.
      expect(result.contributions).toHaveLength(2);
    });
  }

  test("c15_two_findings_of_one_plugin_count_once", () => {
    const artifact = artifact101();
    const one = score(
      [fittedSignal("dev.brandklipparen.ownership", "rug-pull", "medium", "0x8da5cb5b")],
      artifact,
    );
    const two = score(
      [
        fittedSignal("dev.brandklipparen.ownership", "rug-pull", "medium", "0x8da5cb5b"),
        fittedSignal("dev.brandklipparen.ownership", "rug-pull", "medium", "0x715018a6"),
      ],
      artifact,
    );
    expect(two.probabilities).toEqual(one.probabilities);
    expect(two.score as number).toBe(24);
    expect(two.score).toEqual(one.score);
  });

  test("c15_all_owner_detectors_fire", () => {
    const signals = PLUGINS.map((entry) =>
      fittedSignal(entry.plugin, entry.risk, entry.severity, entry.selector),
    );
    const result = score(signals, artifact101());
    expect(result.probabilities["rug-pull"] as number).toBe(0.418596);
    expect(result.probabilities["honeypot"] as number).toBe(0.163138);
    expect(result.score as number).toBe(29);
  });

  test("c15_order_independent", () => {
    const artifact = artifact101();
    const signals = PLUGINS.map((entry) =>
      fittedSignal(entry.plugin, entry.risk, entry.severity, entry.selector),
    );
    const expected = score(signals, artifact);
    fc.assert(
      fc.property(fc.shuffledSubarray(signals, { minLength: signals.length, maxLength: signals.length }), (permuted) => {
        expect(score(permuted, artifact)).toEqual(expected);
      }),
      { seed: 15, numRuns: 25 },
    );
  });

  test("c15_legacy_artifact_unchanged", () => {
    const legacy = mustOk(
      parseModelArtifact({
        version: "0.0.0-synthetic.1",
        severityWeights: { low: 0.25, medium: 0.5, high: 1.0 },
        causeWeights: { timeout: 0.2, "resource-limit": 0.2, "decompiler-error": 0.3, "obfuscated-structure": 0.4 },
        biases: { "rug-pull": -0.5, honeypot: -1.0, "bot-pump": -1.5 },
        calibration: {
          "rug-pull": { slope: 1.0, intercept: 0.0 },
          honeypot: { slope: 1.0, intercept: 0.0 },
          "bot-pump": { slope: 1.0, intercept: 0.0 },
        },
        scoreWeights: { "rug-pull": 0.5, honeypot: 0.3, "bot-pump": 0.2 },
      }),
    );
    const unsourced = (selectorRaw: string): SignalType =>
      mustOk(
        Signal.createCapability({
          codeHash: CODE_HASH,
          risk: "rug-pull",
          direction: "raises",
          severity: "high",
          temporality: { kind: "can-change-unknown" },
          evidence: [evidenceFor(selectorRaw)] as unknown as NonEmpty<EvidenceType>,
        }),
      );
    const one = score([unsourced("0xa9059cbb")], legacy);
    const two = score([unsourced("0xa9059cbb"), unsourced("0x70a08231")], legacy);
    // Without detectorHeadWeights two severity signals still count twice.
    expect(two.probabilities["rug-pull"] as number).toBeGreaterThan(
      one.probabilities["rug-pull"] as number,
    );
    expect(two.contributions).toHaveLength(2);
    expect(two.contributions.every((entry) => entry.weight === 1)).toBe(true);
  });

  test("c15_is_feature_payload", () => {
    expect(isFeaturePayload({ feature: "owner-slot" })).toBe(true);
    expect(isFeaturePayload({ feature: "" })).toBe(false);
    expect(isFeaturePayload({})).toBe(false);
    expect(isFeaturePayload(null)).toBe(false);
    expect(isFeaturePayload("owner-slot")).toBe(false);
    expect(isFeaturePayload([{ feature: "owner-slot" }])).toBe(false);
  });
});
