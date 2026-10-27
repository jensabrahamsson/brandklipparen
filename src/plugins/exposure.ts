// Registry exposure: public plugin list derivation (S-046, P-09, P-10).
// The REST plugin routes, the MCP list_plugins tool and the web Plugins
// panel all read this one derivation, so the three interfaces name the
// same plugins with the same bytes. Detector findings keep weight 0 until
// calibration names them (P-05); the exposure states that expectation and
// never reads the scoring artifact. Assessment plugins name the active
// marker; detector plugins carry the calibrated weight (always 0 until
// S-047). This module imports solely the plugin API and registry types.
import { canonicalSerialize } from "../domain/serialize.ts";
import type { JsonValue, PluginManifest } from "./api.ts";
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
};

export type ExposedPlugin =
  | (ExposedPluginBase & { readonly kind: "detector"; readonly weight: 0 })
  | (ExposedPluginBase & { readonly kind: "assessment"; readonly active: false });

// One manifest in the published shape (P-09): identity, contract and
// bounds, plus the calibrated state for detectors (`weight: 0` until the
// artifact names the plugin) and the active marker for assessment
// plugins. Configuration selects among registered plugins only; the
// exposure never names an unregistered plugin.
export function exposeManifest(manifest: PluginManifest): ExposedPlugin {
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
  };
  switch (manifest.kind) {
    case "detector":
      return Object.freeze({ ...base, kind: "detector", weight: 0 });
    case "assessment":
      return Object.freeze({ ...base, kind: "assessment", active: false });
  }
}

// The registry in registry order, frozen for the response path. Callers
// sort by id where canonical order matters; the assessed envelope already
// sorts pluginResults by plugin id (P-11).
export function exposeRegistry(registry: PluginRegistry): readonly ExposedPlugin[] {
  return Object.freeze(registry.plugins.map(exposeManifest));
}

// Single serialisation path for the plugin list: object keys in
// lexicographic order through canonicalSerialize, so REST and MCP carry
// byte-identical bodies for the same registry value (K-027).
export function serializePluginList(entries: readonly ExposedPlugin[]): string {
  return canonicalSerialize({ plugins: entries as readonly ExposedPlugin[] as never });
}
