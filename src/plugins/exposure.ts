// Registry exposure: public plugin list derivation (S-046, P-09, P-10;
// S-047, P-05 for the calibrated detector weight). The REST plugin routes,
// the MCP list_plugins tool and the web Plugins panel all read this one
// derivation, so the three interfaces name the same plugins with the same
// bytes. Detector findings keep weight 0 until calibration names them: the
// caller hands the composition-supplied weight mapping read once at
// startup from the loaded artifact, and an unnamed plugin exposes weight 0.
// Assessment plugins name the active marker. This module imports solely the
// plugin API, the weight lookup and registry types; it never reads the
// scoring artifact per request.
import { canonicalSerialize } from "../domain/serialize.ts";
import { pluginWeightOf } from "../domain/pluginCalibration.ts";
import type { ModelArtifact } from "../domain/risk.ts";
import type { JsonValue, PluginManifest } from "./api.ts";
import type { ValidatedPluginDocs } from "./docs.ts";
import type { PluginFrontmatter } from "./docs.ts";
import type { PluginRegistry } from "./registry.ts";

export type ExposedPluginCapabilities = {
  readonly needsNetwork: boolean;
  readonly needsSecrets: boolean;
  readonly affectsScore: boolean;
  readonly runsInFastPath: boolean;
};

export type ExposedPluginLimits = {
  readonly maxFindings: number;
  readonly maxEvidencePerFinding: number;
  readonly maxOutputBytes: number;
};

// Validated frontmatter beside the manifest (S-067, K-035, P-25): the
// typed value the web matcher reads, never raw markdown.
export type ExposedPluginFrontmatter = {
  readonly tags: readonly string[];
  readonly audience: readonly string[];
  readonly severity: { readonly min: string; readonly max: string };
};

function frontmatterOf(docs: ValidatedPluginDocs | undefined): ExposedPluginFrontmatter | undefined {
  if (docs === undefined) {
    return undefined;
  }
  const frontmatter: PluginFrontmatter = docs.frontmatter;
  return Object.freeze({
    tags: frontmatter.tags,
    audience: frontmatter.audience,
    severity: frontmatter.severity,
  });
}

type ExposedPluginBase = {
  readonly id: string;
  readonly version: string;
  readonly apiVersion: string;
  readonly displayName: string;
  readonly description: string;
  readonly inputs: readonly string[];
  readonly capabilities: ExposedPluginCapabilities;
  readonly outputSchema: JsonValue;
  readonly limits: ExposedPluginLimits;
  readonly enabled: true;
  // Present exactly when the caller supplies the validated docs record:
  // absent entries expose no frontmatter rather than an unvalidated one.
  readonly frontmatter?: ExposedPluginFrontmatter | undefined;
};

// Calibrated detector weights supplied by the composition root (S-047,
// P-05, P-09): the mapping read once at startup from the loaded artifact.
// Absent entries mean weight 0. The exposure never reads the scoring
// artifact per request.
export type PluginWeightMapping = Readonly<Record<string, number>>;

export type ExposedPlugin =
  | (ExposedPluginBase & { readonly kind: "detector"; readonly weight: number })
  | (ExposedPluginBase & { readonly kind: "assessment"; readonly active: false });

// One manifest in the published shape (P-09): identity, contract and
// bounds, plus the calibrated state for detectors (the artifact weight, 0
// until the artifact names the plugin), the active marker for assessment
// plugins, and the validated frontmatter when the caller hands the
// registry-adjacent docs record. Configuration selects among registered
// plugins only; the exposure never names an unregistered plugin.
export function exposeManifest(
  manifest: PluginManifest,
  weight = 0,
  docs: ValidatedPluginDocs | undefined = undefined,
): ExposedPlugin {
  const frontmatter = frontmatterOf(docs);
  const base: ExposedPluginBase = {
    id: manifest.id,
    version: manifest.version,
    apiVersion: manifest.apiVersion,
    displayName: manifest.displayName,
    description: manifest.description,
    inputs: manifest.inputs,
    capabilities: manifest.capabilities,
    outputSchema: manifest.outputSchema,
    limits: {
      maxFindings: manifest.limits.maxFindings,
      maxEvidencePerFinding: manifest.limits.maxEvidencePerFinding,
      maxOutputBytes: manifest.limits.maxOutputBytes,
    },
    enabled: true,
    ...(frontmatter === undefined ? {} : { frontmatter }),
  };
  switch (manifest.kind) {
    case "detector":
      return Object.freeze({ ...base, kind: "detector", weight });
    case "assessment":
      return Object.freeze({ ...base, kind: "assessment", active: false });
  }
}

// The registry in registry order, frozen for the response path. Callers
// sort by id where canonical order matters; the assessed envelope already
// sorts pluginResults by plugin id (P-11). The validated docs map is the
// registry-adjacent value, so REST and MCP name the same frontmatter.
export function exposeRegistry(
  registry: PluginRegistry,
  weights: PluginWeightMapping = {},
  docs: PluginDocsMap | undefined = undefined,
): readonly ExposedPlugin[] {
  return Object.freeze(
    registry.entries.map((entry) =>
      exposeManifest(entry.manifest, weightOfMapping(weights, entry.manifest.id), docs?.get(entry.manifest.id)),
    ),
  );
}

// Weight mapping for one registry from a loaded artifact (S-047): one
// entry per detector plugin id with the artifact weight, so REST and MCP
// carry the same calibrated state from the same startup read.
export function pluginWeightsOf(
  registry: PluginRegistry,
  artifact: ModelArtifact,
): PluginWeightMapping {
  const out: Record<string, number> = {};
  for (const entry of registry.entries) {
    out[entry.manifest.id] = pluginWeightOf(artifact, entry.manifest.id);
  }
  return Object.freeze(out);
}

// Shared weight read for the driving adapters: one mapping read with the
// same fallback, so REST and MCP name the same calibrated state.
export function weightOfMapping(weights: PluginWeightMapping, pluginId: string): number {
  const stored: unknown = weights[pluginId];
  if (typeof stored !== "number" || !Number.isFinite(stored) || stored < 0) {
    return 0;
  }
  return stored;
}

// Single serialisation path for the plugin list: object keys in
// lexicographic order through canonicalSerialize, so REST and MCP carry
// byte-identical bodies for the same registry value (K-027).
export function serializePluginList(entries: readonly ExposedPlugin[]): string {
  return canonicalSerialize({ plugins: entries as readonly ExposedPlugin[] as never });
}

// Validated docs records keyed by plugin id (S-056, P-16): the one value
// the REST docs route and the MCP docs surface read, so both name the same
// docs for the same plugin.
export type PluginDocsMap = ReadonlyMap<string, ValidatedPluginDocs>;

// Single serialisation path for one plugin's docs: the plugin id, version,
// section list and markdown, so REST and MCP carry byte-identical bodies
// for the same record (K-027).
export function serializePluginDocs(docs: ValidatedPluginDocs): string {
  return canonicalSerialize({
    id: docs.pluginId,
    markdown: docs.markdown,
    sections: docs.sections as readonly string[] as never,
    version: docs.version,
  });
}
