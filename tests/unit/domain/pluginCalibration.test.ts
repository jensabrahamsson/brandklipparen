// Calibration promotion: plugin weights read from the artifact only
// (S-047, P-05, K-210). Written first (red) per A-21: `pluginWeights` is
// absent from the artifact and the exposure hardcodes weight 0, so the
// named-plugin branches fail until the promotion lands. Pure unit test;
// no network, no filesystem.
import { describe, expect, test } from "vitest";
import { parseModelArtifact } from "../../../src/domain/risk.ts";
import type { ModelArtifact } from "../../../src/domain/risk.ts";
import type { Result } from "../../../src/domain/result.ts";
import type { DomainError } from "../../../src/domain/types.ts";
import {
  UNCALIBRATED_PLUGIN_WEIGHT,
  pluginWeightOf,
} from "../../../src/domain/pluginCalibration.ts";
import { exposeRegistry } from "../../../src/plugins/exposure.ts";
import { mustDefaultDetectorSet } from "../../helpers/detectorSets.ts";

const CAPABILITY_ID = "dev.brandklipparen.capability";

function mustArtifact(input: unknown): ModelArtifact {
  const parsed: Result<ModelArtifact, DomainError> = parseModelArtifact(input);
  if (!parsed.ok) {
    throw new Error(`expected a valid artifact: ${parsed.error.message}`);
  }
  return parsed.value;
}

function baseArtifactInput(): Record<string, unknown> {
  return {
    version: "0.1.0",
    severityWeights: { low: 0.2, medium: 0.5, high: 1.0 },
    causeWeights: {
      timeout: 0.4,
      "resource-limit": 0.4,
      "decompiler-error": 0.6,
      "obfuscated-structure": 0.6,
    },
    biases: { "rug-pull": 0.0, honeypot: 0.0, "bot-pump": 0.0 },
    calibration: {
      "rug-pull": { slope: 1.0, intercept: 0.0 },
      honeypot: { slope: 1.0, intercept: 0.0 },
      "bot-pump": { slope: 1.0, intercept: 0.0 },
    },
    scoreWeights: { "rug-pull": 1.0, honeypot: 1.0, "bot-pump": 1.0 },
  };
}

describe("calibration promotion (S-047, K-210)", () => {
  test("k210_plugin_weight_read_from_artifact_only", () => {
    // An artifact that names no plugin leaves every finding at weight 0,
    // across two artifact versions: without the mapping and with an empty
    // mapping.
    const unnamed = mustArtifact(baseArtifactInput());
    expect(pluginWeightOf(unnamed, CAPABILITY_ID)).toBe(UNCALIBRATED_PLUGIN_WEIGHT);
    const emptyNamed = mustArtifact({ ...baseArtifactInput(), pluginWeights: {} });
    expect(pluginWeightOf(emptyNamed, CAPABILITY_ID)).toBe(UNCALIBRATED_PLUGIN_WEIGHT);

    // The decompiler plugin (S-085, D-08) reads its weight from the same
    // artifact mapping: weight 0 with an unnamed artifact, calibrated
    // weight with a naming artifact, across two artifact versions.
    const DECOMPILER_ID = "dev.brandklipparen.decompiler";
    expect(pluginWeightOf(unnamed, DECOMPILER_ID)).toBe(UNCALIBRATED_PLUGIN_WEIGHT);
    expect(pluginWeightOf(emptyNamed, DECOMPILER_ID)).toBe(UNCALIBRATED_PLUGIN_WEIGHT);

    // An artifact that names the plugin carries its calibrated weight.
    const calibrated = mustArtifact({
      ...baseArtifactInput(),
      pluginWeights: { [CAPABILITY_ID]: 1.5, [DECOMPILER_ID]: 0.75 },
    });
    expect(pluginWeightOf(calibrated, CAPABILITY_ID)).toBe(1.5);
    expect(pluginWeightOf(calibrated, DECOMPILER_ID)).toBe(0.75);
    expect(pluginWeightOf(calibrated, "dev.brandklipparen.example-fee-capability")).toBe(
      UNCALIBRATED_PLUGIN_WEIGHT,
    );

    // The weight comes from the artifact only: a manifest display flag
    // cannot raise it, and a malformed stored value can only silence it.
    const malformed = mustArtifact({
      ...baseArtifactInput(),
      pluginWeights: { [CAPABILITY_ID]: 2 },
    });
    expect(pluginWeightOf(malformed, CAPABILITY_ID)).toBe(2);
    expect(mustArtifact(baseArtifactInput()).pluginWeights).toEqual({});
  });

  test("k210_unnamed_plugin_exposes_weight_zero_and_named_plugin_exposes_calibrated_weight", () => {
    const detectors = mustDefaultDetectorSet();
    const unweighted = exposeRegistry(detectors.registry);
    const capabilityUnweighted = unweighted.find((entry) => entry.id === CAPABILITY_ID);
    expect(capabilityUnweighted?.kind).toBe("detector");
    if (capabilityUnweighted?.kind !== "detector") {
      throw new Error("expected the capability detector in the exposure");
    }
    expect(capabilityUnweighted.weight).toBe(0);

    const weighted = exposeRegistry(detectors.registry, { [CAPABILITY_ID]: 1.5 });
    const capabilityWeighted = weighted.find((entry) => entry.id === CAPABILITY_ID);
    if (capabilityWeighted?.kind !== "detector") {
      throw new Error("expected the capability detector in the exposure");
    }
    expect(capabilityWeighted.weight).toBe(1.5);
    const other = weighted.find((entry) => entry.id === "dev.brandklipparen.clone-match");
    if (other?.kind !== "detector") {
      throw new Error("expected the clone-match detector in the exposure");
    }
    expect(other.weight).toBe(0);
    const decompilerUnweighted = unweighted.find((entry) => entry.id === "dev.brandklipparen.decompiler");
    if (decompilerUnweighted?.kind !== "detector") {
      throw new Error("expected the decompiler detector in the exposure");
    }
    expect(decompilerUnweighted.weight).toBe(0);
  });
});
