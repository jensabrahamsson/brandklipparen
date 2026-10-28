// Unit tests for the detector-calibrated freeze path (synthetic only).
// Verifies that score bands and uncalibrated heads round-trip through the
// shared freeze and checksum verification on tiny synthetic data.
import { describe, expect, test } from "vitest";
import { freezeArtifactFile, verifyArtifactFile } from "../../../src/domain/artifact.ts";
import { parseModelArtifact } from "../../../src/domain/risk.ts";
import { ModelVersion } from "../../../src/domain/types.ts";

function mustVersion(text: string): ReturnType<typeof ModelVersion.parse> extends { ok: true; value: infer V } ? V : never {
  const parsed = ModelVersion.parse(text);
  if (!parsed.ok) {
    throw new Error(`bad version: ${text}`);
  }
  return parsed.value as never;
}

describe("detector-calibrated freeze path", () => {
  test("detector head weights survive freeze and steer verification", () => {
    const parsed = parseModelArtifact({
      version: "1.0.0",
      severityWeights: { low: 0.25, medium: 0.5, high: 1 },
      causeWeights: { timeout: 0.2, "resource-limit": 0.2, "decompiler-error": 0.4, "obfuscated-structure": 0.2 },
      biases: { "rug-pull": -0.5, honeypot: -1, "bot-pump": -1.5 },
      calibration: {
        "rug-pull": { slope: 1, intercept: 0 },
        honeypot: { slope: 1, intercept: 0 },
        "bot-pump": { slope: 1, intercept: 0 },
      },
      scoreWeights: { "rug-pull": 0.5, honeypot: 0.3, "bot-pump": 0.2 },
      pluginWeights: { "dev.brandklipparen.mint": 0.5 },
      pluginFeatureCatalogue: {
        "dev.brandklipparen.mint": { risk: "rug-pull", direction: "raises", severity: "high" },
      },
      detectorHeadWeights: {
        "dev.brandklipparen.mint": { "rug-pull": 1.5, honeypot: 0.25 },
      },
      scoreBands: { elevated: 19, high: 60 },
      uncalibratedHeads: ["bot-pump"],
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) {
      throw new Error("expected ok");
    }
    const frozen = freezeArtifactFile({ artifact: parsed.value, dataVersion: "synthetic-test", seed: 42 });
    expect(frozen.ok).toBe(true);
    if (!frozen.ok) {
      throw new Error("expected frozen ok");
    }
    const verified = verifyArtifactFile(JSON.parse(frozen.value) as unknown);
    expect(verified.ok).toBe(true);
    if (!verified.ok) {
      throw new Error("expected verified ok");
    }
    expect(verified.value.artifact.detectorHeadWeights).toEqual({
      "dev.brandklipparen.mint": { "rug-pull": 1.5, honeypot: 0.25 },
    });
    const tampered = JSON.parse(frozen.value) as {
      artifact: { detectorHeadWeights: Record<string, Record<string, number>> };
      checksum: string;
    };
    tampered.artifact.detectorHeadWeights["dev.brandklipparen.mint"] = { "rug-pull": 9.9, honeypot: 0.25 };
    expect(verifyArtifactFile(tampered).ok).toBe(false);
    void mustVersion;
  });

  test("bands and uncalibrated heads survive freeze and verify", () => {
    const parsed = parseModelArtifact({
      version: "1.0.0",
      severityWeights: { low: 0.25, medium: 0.5, high: 1 },
      causeWeights: { timeout: 0.2, "resource-limit": 0.2, "decompiler-error": 0.4, "obfuscated-structure": 0.2 },
      biases: { "rug-pull": -0.5, honeypot: -1, "bot-pump": -1.5 },
      calibration: {
        "rug-pull": { slope: 1, intercept: 0 },
        honeypot: { slope: 1, intercept: 0 },
        "bot-pump": { slope: 1, intercept: 0 },
      },
      scoreWeights: { "rug-pull": 0.5, honeypot: 0.3, "bot-pump": 0.2 },
      pluginWeights: { "dev.brandklipparen.mint": 0.5 },
      pluginFeatureCatalogue: {
        "dev.brandklipparen.mint": { risk: "rug-pull", direction: "raises", severity: "high" },
      },
      scoreBands: { elevated: 19, high: 60 },
      uncalibratedHeads: ["bot-pump"],
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) {
      throw new Error("expected ok");
    }
    const frozen = freezeArtifactFile({ artifact: parsed.value, dataVersion: "synthetic-test", seed: 42 });
    expect(frozen.ok).toBe(true);
    if (!frozen.ok) {
      throw new Error("expected frozen ok");
    }
    const verified = verifyArtifactFile(JSON.parse(frozen.value) as unknown);
    expect(verified.ok).toBe(true);
    if (!verified.ok) {
      throw new Error("expected verified ok");
    }
    expect(verified.value.artifact.scoreBands).toEqual({ elevated: 19, high: 60 });
    expect(verified.value.artifact.uncalibratedHeads).toEqual(["bot-pump"]);
    expect(verified.value.dataVersion).toBe("synthetic-test");
    void mustVersion;
  });
});
