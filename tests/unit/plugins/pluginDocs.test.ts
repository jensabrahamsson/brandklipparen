// Required `PLUGIN.md` deterministic checks (S-052, K-032, K-517).
// Written first (red) per A-21: no validator exists yet, so every branch
// below fails until it lands. Pure unit tests; no network, no registry.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { PLUGIN_API_VERSION, PluginManifest } from "../../../src/plugins/api.ts";
import type { DetectorManifest, PluginManifest as PluginManifestType } from "../../../src/plugins/api.ts";
import type { Result } from "../../../src/domain/result.ts";
import { validatePluginDocs } from "../../../src/plugins/docs.ts";
import type { PluginDocsError } from "../../../src/plugins/docs.ts";
import { capabilityDetectorPlugin } from "../../../src/plugins/detectors/capability/index.ts";
import { cloneMatchDetectorPlugin } from "../../../src/plugins/detectors/clone-match/index.ts";
import { hardToAnalyzeDetectorPlugin } from "../../../src/plugins/detectors/hard-to-analyze/index.ts";
import { metaModelApiAssessmentPlugin } from "../../../src/plugins/assessments/meta-model-api/index.ts";
import { feeCapabilityManifest } from "../../../examples/plugins/fee-capability/manifest.ts";

function mustManifest(): DetectorManifest {
  const parsed = PluginManifest.parse({
    id: "dev.brandklipparen.capability",
    version: "1.0.0",
    kind: "detector",
    apiVersion: PLUGIN_API_VERSION,
    displayName: "Capability detector",
    description: "Reports structural bytecode capabilities with selector evidence.",
    inputs: ["bytecode"],
    docs: "PLUGIN.md",
    outputSchema: { type: "object", additionalProperties: false },
    capabilities: {},
    limits: { maxFindings: 8, maxEvidencePerFinding: 128, maxOutputBytes: 32768 },
  });
  if (!parsed.ok) {
    throw new Error(`test manifest failed to parse: ${parsed.error.kind}`);
  }
  if (parsed.value.kind !== "detector") {
    throw new Error("test manifest carries the wrong kind");
  }
  return parsed.value;
}

function compliantDocs(): string {
  return [
    "---",
    "id: dev.brandklipparen.capability",
    "kind: detector",
    "version: 1.0.0",
    "tags: [owner-powers, upgradeability]",
    "audience: [holder, auditor]",
    "severity: { min: low, max: high }",
    "---",
    "# PLUGIN.md: Capability detector (`dev.brandklipparen.capability`)",
    "",
    "Version 1.0.0. First-party detector plugin.",
    "",
    "## What it checks",
    "",
    "Structural bytecode capabilities, one finding per capability key.",
    "",
    "## Why it matters to you",
    "",
    "A selfdestruct or delegatecall capability can drain or redirect funds.",
    "",
    "## What it cannot tell you",
    "",
    "Whether the capability is reachable or guarded.",
    "",
    "## Evidence format",
    "",
    "Findings carry `id`, `title`, `payload` and `evidence` with a `selector`.",
    "",
    "## Limitations / false positives",
    "",
    "Dead code still counts: presence is not reachability.",
    "",
    "## Inputs",
    "",
    "Declared inputs: `bytecode` (with its code hash).",
    "",
    "## Version and changelog",
    "",
    "Version 1.0.0. Initial release.",
    "",
  ].join("\n");
}

function docsError(manifest: DetectorManifest, markdown: unknown): PluginDocsError {
  const checked: Result<unknown, PluginDocsError> = validatePluginDocs(manifest, markdown);
  if (checked.ok) {
    throw new Error("expected a docs failure, got ok");
  }
  return checked.error;
}

describe("required PLUGIN.md deterministic checks (S-052, K-517)", () => {
  test("k517_plugin_md_missing_or_mismatched_fails_deterministic_check", () => {
    const manifest = mustManifest();
    expect(docsError(manifest, undefined).kind).toBe("missing-file");
    expect(
      docsError(manifest, compliantDocs().replace("## Evidence format", "## Output")).kind,
    ).toBe("missing-section");
    expect(
      docsError(
        manifest,
        compliantDocs().replace("Declared inputs: `bytecode`", "Declared inputs: `bytecode` and `tape`"),
      ).kind,
    ).toBe("undeclared-input");
    expect(docsError(manifest, compliantDocs().replace("Version 1.0.0", "Version 2.0.0")).kind).toBe(
      "version-mismatch",
    );
  });

  test("plugin_md_validator_accepts_compliant_plugin", () => {
    const checked = validatePluginDocs(mustManifest(), compliantDocs());
    if (!checked.ok) {
      throw new Error(`expected ok, got: ${checked.error.kind} ${checked.error.message}`);
    }
    expect(checked.value.pluginId).toBe("dev.brandklipparen.capability");
    expect(checked.value.version).toBe("1.0.0");
    expect(checked.value.sections).toContain("Inputs");
    expect(Object.isFrozen(checked.value)).toBe(true);
  });

  test("plugin_md_backfilled_docs_pass_for_registered_and_example_plugins", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const repoRoot = join(here, "..", "..", "..");
    const cases: ReadonlyArray<{ readonly dir: string; readonly manifest: PluginManifestType }> = [
      { dir: "src/plugins/detectors/capability", manifest: capabilityDetectorPlugin.manifest },
      { dir: "src/plugins/detectors/clone-match", manifest: cloneMatchDetectorPlugin.manifest },
      { dir: "src/plugins/detectors/hard-to-analyze", manifest: hardToAnalyzeDetectorPlugin.manifest },
      { dir: "src/plugins/assessments/meta-model-api", manifest: metaModelApiAssessmentPlugin.manifest },
      { dir: "examples/plugins/fee-capability", manifest: feeCapabilityManifest },
    ];
    for (const entry of cases) {
      const markdown = readFileSync(join(repoRoot, entry.dir, "PLUGIN.md"), "utf8");
      const checked = validatePluginDocs(entry.manifest, markdown);
      if (!checked.ok) {
        throw new Error(
          `backfilled docs for ${entry.manifest.id} must pass: ${checked.error.kind} ${checked.error.message}`,
        );
      }
      expect(checked.value.pluginId).toBe(entry.manifest.id);
    }
  });
});
