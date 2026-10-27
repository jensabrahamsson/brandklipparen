// Tests for S-071 (D-1, D-2, D-4, D-5): registry reconciliation with the
// reviewed ADR (section 0.3). Written first (red) per A-21: projection,
// discriminated manifests, boundary re-proof and registry entries do not
// exist yet, so the imports below fail until the implementation lands.
// D-3 lands through S-052/S-065 and D-6 through S-047, so this suite pins
// only the S-071 behaviours and leaves docs and converter seams alone.
import { describe, expect, test } from "vitest";
import { PluginManifest } from "../../../src/plugins/api.ts";
import { buildPluginRegistry } from "../../../src/plugins/registry.ts";
import {
  createDetectorInput,
  projectDetectorInput,
  runDetectorPlugin,
} from "../../../src/plugins/detector.ts";
import type { DetectorPlugin } from "../../../src/plugins/detector.ts";
import { buildDetectorSet, wireAppServices } from "../../../src/composition/root.ts";
import { capabilityDetectorPlugin } from "../../../src/plugins/detectors/capability/index.ts";
import { cloneMatchDetectorPlugin } from "../../../src/plugins/detectors/clone-match/index.ts";
import { hardToAnalyzeDetectorPlugin } from "../../../src/plugins/detectors/hard-to-analyze/index.ts";
import { Bytecode, CloneGroupId, CodeHash, Probability } from "../../../src/domain/types.ts";
import type { Result } from "../../../src/domain/result.ts";
import type { CloneHit } from "../../../src/domain/clones.ts";

function mustOk<T, E extends { message: string }>(result: Result<T, E>): T {
  if (!result.ok) {
    throw new Error(`expected ok, got error: ${result.error.message}`);
  }
  return result.value;
}

const TEMPLATE_A_CODE = "0x8063a9059cbb14600a575bff00";

function fullFacts() {
  const bytecode = mustOk(Bytecode.parse(TEMPLATE_A_CODE));
  const hit: CloneHit = Object.freeze({
    similarity: mustOk(Probability.of(1)),
    group: mustOk(CloneGroupId.parse("trap-fixed-fee")),
    priorCount: 3,
  });
  return createDetectorInput(bytecode, mustOk(CodeHash.of(bytecode)), {
    cloneMatch: hit,
    decompilerCause: "timeout",
  });
}

function stubPluginWith(findings: unknown): DetectorPlugin {
  return Object.freeze({
    manifest: cloneMatchDetectorPlugin.manifest,
    detect: (() => findings) as DetectorPlugin["detect"],
  });
}

describe("registry reconciliation with the reviewed ADR (S-071)", () => {
  test("registry_projects_only_declared_inputs_per_detector", () => {
    const facts = fullFacts();
    const plugins: readonly DetectorPlugin[] = [
      capabilityDetectorPlugin,
      cloneMatchDetectorPlugin,
      hardToAnalyzeDetectorPlugin,
    ];
    expect(capabilityDetectorPlugin.manifest.inputs).toEqual(["bytecode"]);
    expect(cloneMatchDetectorPlugin.manifest.inputs).toEqual(["bytecode", "cloneMatch"]);
    expect(hardToAnalyzeDetectorPlugin.manifest.inputs).toContain("decompilerCause");
    for (const plugin of plugins) {
      const declared = new Set<string>(plugin.manifest.inputs as readonly string[]);
      const projected = projectDetectorInput(plugin.manifest, facts);
      expect("bytecode" in projected).toBe(true);
      expect("codeHash" in projected).toBe(true);
      expect("cloneMatch" in projected).toBe(declared.has("cloneMatch"));
      expect("decompilerCause" in projected).toBe(declared.has("decompilerCause"));
      const projectedOutcome = runDetectorPlugin(plugin, projected);
      const fullOutcome = runDetectorPlugin(plugin, facts);
      expect(projectedOutcome).toEqual(fullOutcome);
    }
  });

  test("manifest_smart_constructor_rejects_detector_network_capability", () => {
    const base = {
      id: "dev.brandklipparen.capability",
      version: "1.0.0",
      kind: "detector",
      apiVersion: "1.0.0",
      displayName: "Capability detector",
      description: "Reports structural bytecode capabilities with selector evidence.",
      inputs: ["bytecode"],
      docs: "PLUGIN.md",
      outputSchema: { type: "object", additionalProperties: false },
      limits: { maxFindings: 8, maxEvidencePerFinding: 128, maxOutputBytes: 32768 },
    };
    const networked = PluginManifest.parse({ ...base, capabilities: { needsNetwork: true } });
    expect(networked.ok).toBe(false);
    if (networked.ok) {
      throw new Error("expected a detector with needsNetwork to fail construction");
    }
    expect(networked.error.kind).toBe("invalid-plugin-capabilities");
    const secreted = PluginManifest.parse({ ...base, capabilities: { needsSecrets: true } });
    expect(secreted.ok).toBe(false);
    if (secreted.ok) {
      throw new Error("expected a detector with needsSecrets to fail construction");
    }
    expect(secreted.error.kind).toBe("invalid-plugin-capabilities");
  });

  test("registry_reparses_evidence_and_checks_finding_identity", () => {
    const prefix = cloneMatchDetectorPlugin.manifest.id;
    const validPayload = Object.freeze({ similarity: 1, group: "trap-fixed-fee", priorCount: 3 });
    const validEvidence = Object.freeze([{ selector: "0xa9059cbb" }]);
    const validFinding = {
      id: `${prefix}:trap-fixed-fee`,
      pluginId: prefix,
      title: "Token matches known clone group trap-fixed-fee",
      evidence: validEvidence,
      payload: validPayload,
    };
    const control = runDetectorPlugin(stubPluginWith([validFinding]), fullFacts());
    expect(control.outcome).toBe("ok");

    const selectorShaped = runDetectorPlugin(
      stubPluginWith([{ ...validFinding, evidence: [{ selector: "a9059cbb" }] }]),
      fullFacts(),
    );
    expect(selectorShaped.outcome).toBe("invalid-output");

    const wrongPrefix = runDetectorPlugin(
      stubPluginWith([{ ...validFinding, id: "dev.brandklipparen.other:trap-fixed-fee" }]),
      fullFacts(),
    );
    expect(wrongPrefix.outcome).toBe("invalid-output");

    const mismatchedId = runDetectorPlugin(
      stubPluginWith([{ ...validFinding, pluginId: "dev.brandklipparen.other" }]),
      fullFacts(),
    );
    expect(mismatchedId.outcome).toBe("invalid-output");
  });

  test("composition_builds_registry_entries_or_typed_startup_error", () => {
    const built = buildDetectorSet();
    expect(built.ok).toBe(true);
    if (!built.ok) {
      throw new Error("expected the composition detector set to build");
    }
    expect(built.value.registry.entries.map((entry) => entry.manifest.id)).toEqual([
      "dev.brandklipparen.capability",
      "dev.brandklipparen.clone-match",
      "dev.brandklipparen.hard-to-analyze",
    ]);
    expect(Object.isFrozen(built.value.registry)).toBe(true);
    expect(wireAppServices.length).toBe(2);

    const missing = buildPluginRegistry([
      { manifest: capabilityDetectorPlugin.manifest } as unknown as DetectorPlugin,
    ]);
    expect(missing.ok).toBe(false);
    if (missing.ok) {
      throw new Error("expected a manifest without an implementation to fail startup");
    }
    expect(missing.error.kind).toBe("missing-plugin-implementation");
    expect(missing.error.pluginId).toBe("dev.brandklipparen.capability");
  });
});
