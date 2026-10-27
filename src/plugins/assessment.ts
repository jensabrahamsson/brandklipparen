// Assessment plugin entry point (S-045, P-04).
// An assessment plugin is an AssessmentModelPort implementation plus a
// manifest with kind "assessment". This module owns the entry shape and
// the provider-to-plugin-id mapping; the two concrete plugin modules
// under src/plugins/assessments/ hold the manifests, and the composition
// root binds exactly one of them as the active adapter (A-34). The port,
// its error union, its limits and the exactly-one rule stay as they are:
// configuration selects among already-registered plugins only and never
// names code to load (P-07). This module imports solely the plugin API
// and port types, so the detector purity boundary is unaffected.
import type { PluginId, PluginManifest } from "./api.ts";
import type { AssessmentProvider } from "../ports/assessmentModel.ts";

// One registered assessment plugin: the manifest plus the provider whose
// AssessmentModelPort implementation it wraps. The manifest kind is
// always "assessment"; createAssessmentPlugin enforces that at module
// load, so a detector manifest can never register here.
export type AssessmentPlugin = {
  readonly manifest: PluginManifest;
  readonly provider: AssessmentProvider;
};

// Fixed plugin ids for the two assessment adapters (S-045). The same
// literals appear in the plugin manifests, where PluginManifest.parse
// validates them; the cast below is safe because a mismatched literal
// fails fast at module load.
const META_MODEL_API_PLUGIN_ID =
  "dev.brandklipparen.assessment.meta-model-api" as PluginId;
const hosted_OPEN_WEIGHTS_PLUGIN_ID =
  "dev.brandklipparen.assessment.hosted-open-weights" as PluginId;

export const ASSESSMENT_PLUGIN_IDS: Readonly<Record<AssessmentProvider, PluginId>> =
  Object.freeze({
    "meta-model-api": META_MODEL_API_PLUGIN_ID,
    "hosted-open-weights": hosted_OPEN_WEIGHTS_PLUGIN_ID,
  });

// Maps a configured provider to its registered plugin id. Exactly one
// plugin is active at a time, selected by validated configuration as
// before (K-309).
export function assessmentPluginIdForProvider(provider: AssessmentProvider): PluginId {
  switch (provider) {
    case "meta-model-api":
      return META_MODEL_API_PLUGIN_ID;
    case "hosted-open-weights":
      return hosted_OPEN_WEIGHTS_PLUGIN_ID;
  }
}

// Smart constructor for the entry: rejects a non-assessment manifest at
// module load, so the assessment registry holds solely assessment plugins.
export function createAssessmentPlugin(
  manifest: PluginManifest,
  provider: AssessmentProvider,
): AssessmentPlugin {
  if (manifest.kind !== "assessment") {
    throw new Error(
      `assessment plugin for provider ${provider} carries kind ${manifest.kind}`,
    );
  }
  return Object.freeze({ manifest, provider });
}

// Executable lookup beside the validated manifest registry: the
// composition root resolves the single active plugin through this table,
// so an unregistered plugin never runs.
export function assessmentPluginTable(
  plugins: readonly AssessmentPlugin[],
): ReadonlyMap<PluginId, AssessmentPlugin> {
  const table = new Map<PluginId, AssessmentPlugin>();
  for (const plugin of plugins) {
    table.set(plugin.manifest.id, plugin);
  }
  return table;
}

export function getAssessmentPlugin(
  table: ReadonlyMap<PluginId, AssessmentPlugin>,
  id: string,
): AssessmentPlugin | undefined {
  return table.get(id as PluginId);
}
