// Assessment plugin registry (S-045, K-030 proposed).
// Written first (red) per A-21: the assessment adapter registers as an
// assessment plugin with a fixed plugin id, and configuration selects
// it by plugin id. The port, its error union, its limits
// and the exactly-one rule (A-34) stay as they are.
import { describe, expect, test } from "vitest";
import { isSupportedApiVersion, PluginManifest } from "../../../src/plugins/api.ts";
import type { PluginId } from "../../../src/plugins/api.ts";
import {
  ASSESSMENT_PLUGIN_IDS,
  assessmentPluginIdForProvider,
  assessmentPluginTable,
  getAssessmentPlugin,
} from "../../../src/plugins/assessment.ts";
import {
  metaModelApiAssessmentPlugin,
} from "../../../src/plugins/assessments/meta-model-api/index.ts";
import { buildAssessmentRegistry } from "../../../src/plugins/registry.ts";
import type { AssessmentProvider } from "../../../src/ports/assessmentModel.ts";

function asPluginId(raw: string): PluginId {
  return raw as PluginId;
}

describe("assessment plugin registry (S-045)", () => {
  test("exactly_one_assessment_plugin_registered_with_fixed_id", () => {
    const plugins = [metaModelApiAssessmentPlugin];
    expect(plugins.length).toBe(1);
    expect(metaModelApiAssessmentPlugin.manifest.id).toBe(
      "dev.brandklipparen.assessment.meta-model-api",
    );
    for (const plugin of plugins) {
      expect(plugin.manifest.kind).toBe("assessment");
      expect(plugin.manifest.inputs).toEqual([]);
      expect(plugin.provider).toBeDefined();
    }
    expect(metaModelApiAssessmentPlugin.provider).toBe("meta-model-api");
  });

  test("assessment_manifests_parse_with_supported_api_and_assessment_defaults", () => {
    for (const plugin of [metaModelApiAssessmentPlugin]) {
      expect(isSupportedApiVersion(plugin.manifest.apiVersion)).toBe(true);
      expect(plugin.manifest.capabilities.needsNetwork).toBe(true);
      expect(plugin.manifest.capabilities.needsSecrets).toBe(false);
      expect(plugin.manifest.capabilities.affectsScore).toBe(false);
      expect(plugin.manifest.capabilities.runsInFastPath).toBe(false);
      const rebuilt = PluginManifest.parse(JSON.parse(JSON.stringify(plugin.manifest)));
      expect(rebuilt.ok).toBe(true);
    }
  });

  test("provider_maps_to_exactly_one_plugin_id", () => {
    const cases: ReadonlyArray<{ provider: AssessmentProvider; id: string }> = [
      { provider: "meta-model-api", id: "dev.brandklipparen.assessment.meta-model-api" },
    ];
    for (const { provider, id } of cases) {
      expect(assessmentPluginIdForProvider(provider)).toBe(id);
      expect(ASSESSMENT_PLUGIN_IDS[provider]).toBe(id);
    }
    expect(Object.keys(ASSESSMENT_PLUGIN_IDS).sort()).toEqual(["meta-model-api"]);
  });

  test("assessment_registry_builds_with_unique_ids_and_lookup_by_plugin_id", () => {
    const built = buildAssessmentRegistry([metaModelApiAssessmentPlugin]);
    expect(built.ok).toBe(true);
    if (!built.ok) {
      return;
    }
    const registry = built.value;
    expect(registry.entries.length).toBe(1);
    expect(Object.isFrozen(registry)).toBe(true);
    const table = assessmentPluginTable([metaModelApiAssessmentPlugin]);
    for (const id of ["dev.brandklipparen.assessment.meta-model-api"] as const) {
      const plugin = getAssessmentPlugin(table, id);
      expect(plugin?.manifest.id).toBe(id);
    }
    expect(getAssessmentPlugin(table, "dev.brandklipparen.assessment.absent")).toBe(undefined);
    expect(
      getAssessmentPlugin(table, asPluginId("dev.brandklipparen.capability")),
    ).toBe(undefined);
  });

  test("duplicate_assessment_ids_fail_the_registry_builder", () => {
    const duplicated = buildAssessmentRegistry([
      metaModelApiAssessmentPlugin,
      metaModelApiAssessmentPlugin,
    ]);
    expect(duplicated.ok).toBe(false);
    if (duplicated.ok) {
      throw new Error("expected a duplicate plugin id error");
    }
    expect(duplicated.error.kind).toBe("duplicate-plugin-id");
  });
});
