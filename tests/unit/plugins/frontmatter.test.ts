// S-065 strict PLUGIN.md frontmatter (K-035, K-032, P-15 refined).
// Every plugin doc carries a YAML frontmatter block with the closed
// vocabulary (`tags`, `audience`, severity range on the domain scale)
// and the renamed plain-English sections, checked deterministically in
// CI with zero network calls. Written first (red) per A-21: the
// frontmatter validator does not exist yet.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { PLUGIN_API_VERSION, PluginManifest } from "../../../src/plugins/api.ts";
import type { DetectorManifest } from "../../../src/plugins/api.ts";
import type { Result } from "../../../src/domain/result.ts";
import { validatePluginDocs } from "../../../src/plugins/docs.ts";
import type { PluginDocsError } from "../../../src/plugins/docs.ts";
import { capabilityDetectorPlugin } from "../../../src/plugins/detectors/capability/index.ts";
import { cloneMatchDetectorPlugin } from "../../../src/plugins/detectors/clone-match/index.ts";
import { hardToAnalyzeDetectorPlugin } from "../../../src/plugins/detectors/hard-to-analyze/index.ts";
import { hostedOpenWeightsAssessmentPlugin } from "../../../src/plugins/assessments/hosted-open-weights/index.ts";
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
  if (!parsed.ok || parsed.value.kind !== "detector") {
    throw new Error("test manifest failed to parse");
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
    "Whether the capability is reachable or guarded by ownership checks.",
    "",
    "## Evidence format",
    "",
    "Findings carry `id`, `title`, `payload` with `capability`, and `evidence` with `selector`.",
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

describe("strict PLUGIN.md frontmatter (S-065)", () => {
  test("plugin_md_frontmatter_validator_accepts_compliant_plugin", () => {
    const checked = validatePluginDocs(mustManifest(), compliantDocs());
    if (!checked.ok) {
      throw new Error(`expected ok, got: ${checked.error.kind} ${checked.error.message}`);
    }
    expect(checked.value.pluginId).toBe("dev.brandklipparen.capability");
    expect(checked.value.frontmatter.tags).toEqual(["owner-powers", "upgradeability"]);
    expect(checked.value.frontmatter.severity).toEqual({ min: "low", max: "high" });
    expect(checked.value.sections).toContain("What it checks");
    expect(checked.value.sections).toContain("Version and changelog");
  });

  test("k517_plugin_md_missing_or_mismatched_fails_deterministic_check frontmatter branches", () => {
    const manifest = mustManifest();
    expect(docsError(manifest, compliantDocs().replace("tags: [owner-powers, upgradeability]\n", "")).kind).toBe(
      "missing-frontmatter-field",
    );
    expect(
      docsError(manifest, compliantDocs().replace("tags: [owner-powers, upgradeability]", "tags: [mind-control]")).kind,
    ).toBe("unknown-tag");
    expect(
      docsError(
        manifest,
        compliantDocs().replace("audience: [holder, auditor]", "audience: [holder, auditor]\ntopics: [fees]"),
      ).kind,
    ).toBe("topics-mismatch");
    const withMatchingTopics = validatePluginDocs(
      manifest,
      compliantDocs().replace(
        "tags: [owner-powers, upgradeability]",
        "tags: [owner-powers, upgradeability]\ntopics: [owner-powers, upgradeability]",
      ),
    );
    expect(withMatchingTopics.ok).toBe(true);
    expect(
      docsError(manifest, compliantDocs().replace("severity: { min: low, max: high }", "severity: { min: high, max: low }"))
        .kind,
    ).toBe("invalid-severity-range");
    expect(
      docsError(manifest, compliantDocs().replace("## What it checks", "## What it detects")).kind,
    ).toBe("missing-section");
    expect(
      docsError(manifest, `${compliantDocs()}\n<script>alert(1)</script>\n`).kind,
    ).toBe("raw-html");
  });

  test("k035_frontmatter_checked_in_ci_without_network", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const repoRoot = join(here, "..", "..", "..");
    const cases = [
      { dir: "src/plugins/detectors/capability", manifest: capabilityDetectorPlugin.manifest },
      { dir: "src/plugins/detectors/clone-match", manifest: cloneMatchDetectorPlugin.manifest },
      { dir: "src/plugins/detectors/hard-to-analyze", manifest: hardToAnalyzeDetectorPlugin.manifest },
      { dir: "src/plugins/assessments/meta-model-api", manifest: metaModelApiAssessmentPlugin.manifest },
      { dir: "src/plugins/assessments/hosted-open-weights", manifest: hostedOpenWeightsAssessmentPlugin.manifest },
      { dir: "examples/plugins/fee-capability", manifest: feeCapabilityManifest },
    ] as const;
    for (const entry of cases) {
      // Pure file reads plus the pure validator: zero network calls.
      const markdown = readFileSync(join(repoRoot, entry.dir, "PLUGIN.md"), "utf8");
      const checked = validatePluginDocs(entry.manifest, markdown);
      if (!checked.ok) {
        throw new Error(
          `frontmatter docs for ${entry.manifest.id} must pass: ${checked.error.kind} ${checked.error.message}`,
        );
      }
    }
  });
});
