// Tests for S-042 (K-028 proposed): manifest smart constructors (P-01).
// Written first (red) per A-21; the implementation lives in
// src/plugins/api.ts. Every invalid manifest fails construction with a
// typed error naming the field; no value reaches the registry unvalidated.
import { describe, expect, test } from "vitest";
import { PLUGIN_API_VERSION, PluginManifest } from "../../../src/plugins/api.ts";
import type { PluginManifestError } from "../../../src/plugins/api.ts";
import type { Result } from "../../../src/domain/result.ts";

function validManifestInput(): Record<string, unknown> {
  return {
    id: "dev.brandklipparen.capability",
    version: "1.2.0",
    kind: "detector",
    apiVersion: "1.0.0",
    displayName: "Capability detector",
    description: "Reports owner capabilities with selector evidence.",
    inputs: ["bytecode", "cloneMatch"],
    docs: "PLUGIN.md",
    outputSchema: {
      type: "object",
      required: ["findings"],
      properties: {
        findings: { type: "array", items: { type: "string" }, maxItems: 100 },
      },
      additionalProperties: false,
    },
    capabilities: {},
    limits: { maxFindings: 100, maxEvidencePerFinding: 8, maxOutputBytes: 65536 },
  };
}

function parseError(input: Record<string, unknown>): PluginManifestError {
  const parsed = PluginManifest.parse(input);
  if (parsed.ok) {
    throw new Error("expected a manifest error, got ok");
  }
  return parsed.error;
}

describe("plugin manifest smart constructors", () => {
  test("valid_manifest_parses_and_freezes", () => {
    const parsed = PluginManifest.parse(validManifestInput());
    if (!parsed.ok) {
      throw new Error(`expected ok, got: ${parsed.error.kind} ${parsed.error.message}`);
    }
    expect(parsed.value.id).toBe("dev.brandklipparen.capability");
    expect(parsed.value.kind).toBe("detector");
    expect(Object.isFrozen(parsed.value)).toBe(true);
  });

  test("plugin_api_version_constant_is_valid_semver", () => {
    const parsed: Result<unknown, PluginManifestError> = PluginManifest.parse({
      ...validManifestInput(),
      apiVersion: PLUGIN_API_VERSION,
    });
    expect(parsed.ok).toBe(true);
  });

  test("manifest_rejects_bad_ids_on_both_sides_of_the_boundary", () => {
    const badIds = ["", "NoDots", "dev.", ".leading", "dev..double", "DEV.upper", "dev_under", "dev.brandklipparen!"];
    for (const id of badIds) {
      expect(parseError({ ...validManifestInput(), id }).kind).toBe("invalid-plugin-id");
    }
    const okIds = ["a.b", "dev.brandklipparen.capability", "dev.brand-2.x9"];
    for (const id of okIds) {
      expect(PluginManifest.parse({ ...validManifestInput(), id }).ok).toBe(true);
    }
  });

  test("manifest_rejects_non_semver_version_and_api_version", () => {
    expect(parseError({ ...validManifestInput(), version: "1.2" }).kind).toBe(
      "invalid-plugin-version",
    );
    expect(parseError({ ...validManifestInput(), version: "v1.2.3" }).kind).toBe(
      "invalid-plugin-version",
    );
    expect(parseError({ ...validManifestInput(), apiVersion: "1.0" }).kind).toBe(
      "invalid-plugin-api-version",
    );
  });

  test("manifest_rejects_unknown_kind", () => {
    expect(parseError({ ...validManifestInput(), kind: "datasource" }).kind).toBe(
      "invalid-plugin-kind",
    );
  });

  test("manifest_rejects_empty_display_name_and_description", () => {
    expect(parseError({ ...validManifestInput(), displayName: "" }).kind).toBe(
      "invalid-plugin-display-name",
    );
    expect(parseError({ ...validManifestInput(), description: "   " }).kind).toBe(
      "invalid-plugin-description",
    );
  });

  test("manifest_rejects_unknown_and_duplicate_inputs", () => {
    expect(parseError({ ...validManifestInput(), inputs: ["bytecode", "tape"] }).kind).toBe(
      "invalid-plugin-inputs",
    );
    expect(
      parseError({ ...validManifestInput(), inputs: ["bytecode", "bytecode"] }).kind,
    ).toBe("invalid-plugin-inputs");
  });

  test("manifest_rejects_detector_inputs_for_assessment_kind", () => {
    expect(
      parseError({ ...validManifestInput(), kind: "assessment", inputs: ["bytecode"] }).kind,
    ).toBe("invalid-plugin-inputs");
    expect(
      PluginManifest.parse({
        ...validManifestInput(),
        kind: "assessment",
        inputs: [],
        limits: {
          maxFindings: 100,
          maxEvidencePerFinding: 8,
          maxOutputBytes: 65536,
          deadlineMs: 30000,
          maxBytesIn: 1048576,
          maxBytesOut: 65536,
          maxConcurrency: 2,
        },
      }).ok,
    ).toBe(true);
  });

  test("manifest_requires_the_fixed_plugin_md_docs_reference", () => {
    expect(parseError({ ...validManifestInput(), docs: undefined }).kind).toBe(
      "invalid-plugin-docs",
    );
    expect(parseError({ ...validManifestInput(), docs: "README.md" }).kind).toBe(
      "invalid-plugin-docs",
    );
    const parsed = PluginManifest.parse(validManifestInput());
    if (!parsed.ok) {
      throw new Error(`expected ok, got: ${parsed.error.kind}`);
    }
    expect(parsed.value.docs).toBe("PLUGIN.md");
  });

  test("manifest_rejects_output_schema_outside_the_supported_subset", () => {
    expect(
      parseError({ ...validManifestInput(), outputSchema: { type: "object", pattern: "^a" } })
        .kind,
    ).toBe("invalid-plugin-output-schema");
    expect(
      parseError({ ...validManifestInput(), outputSchema: { type: "hyperobject" } }).kind,
    ).toBe("invalid-plugin-output-schema");
    expect(parseError({ ...validManifestInput(), outputSchema: "object" }).kind).toBe(
      "invalid-plugin-output-schema",
    );
  });

  test("manifest_applies_capability_defaults_per_kind", () => {
    const detector = PluginManifest.parse(validManifestInput());
    if (!detector.ok) {
      throw new Error(`expected ok, got: ${detector.error.kind}`);
    }
    expect(detector.value.capabilities).toEqual({
      needsNetwork: false,
      needsSecrets: false,
      affectsScore: false,
      runsInFastPath: true,
    });
    const assessment = PluginManifest.parse({
      ...validManifestInput(),
      kind: "assessment",
      inputs: [],
      limits: {
        maxFindings: 1,
        maxEvidencePerFinding: 1,
        maxOutputBytes: 20000,
        deadlineMs: 30000,
        maxBytesIn: 1048576,
        maxBytesOut: 20000,
        maxConcurrency: 2,
      },
    });
    if (!assessment.ok) {
      throw new Error(`expected ok, got: ${assessment.error.kind}`);
    }
    expect(assessment.value.capabilities).toEqual({
      needsNetwork: true,
      needsSecrets: false,
      affectsScore: false,
      runsInFastPath: false,
    });
  });

  test("manifest_rejects_bad_limits", () => {
    expect(
      parseError({
        ...validManifestInput(),
        limits: { maxFindings: 0, maxEvidencePerFinding: 8, maxOutputBytes: 100 },
      }).kind,
    ).toBe("invalid-plugin-limits");
    expect(
      parseError({
        ...validManifestInput(),
        limits: { maxFindings: 1.5, maxEvidencePerFinding: 8, maxOutputBytes: 100 },
      }).kind,
    ).toBe("invalid-plugin-limits");
  });
});
