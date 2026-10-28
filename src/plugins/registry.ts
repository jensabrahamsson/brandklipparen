// Static plugin registry (S-042, P-07, P-08; reconciled in S-071 per ADR
// section 0.3, D-5). The registry is a set of entries, not a manifest list
// beside a separate executable map: one entry per plugin carrying its
// manifest and, for detectors, its `detect` function. A registered
// detector without its implementation is unrepresentable; startup
// validates the entry set once through `buildPluginRegistry`, which
// returns a typed error and never throws. The static entry array is
// assembled from static values; configuration selects among
// already-registered plugins only and never names code to load (P-07).
// No registry is built at module load: an import must never fail a
// process the composition root has not yet validated.
import { err, ok } from "../domain/result.ts";
import type { Result } from "../domain/result.ts";
import { PLUGIN_API_VERSION, isSupportedApiVersion } from "./api.ts";
import type { DetectorManifest, PluginId } from "./api.ts";
import type { AssessmentPlugin } from "./assessment.ts";
import type { DetectorPlugin } from "./detector.ts";
import { hostedOpenWeightsAssessmentPlugin } from "./assessments/hosted-open-weights/index.ts";
import { metaModelApiAssessmentPlugin } from "./assessments/meta-model-api/index.ts";
import { capabilityDetectorPlugin } from "./detectors/capability/index.ts";
import { cloneMatchDetectorPlugin } from "./detectors/clone-match/index.ts";
import { decompilerDetectorPlugin } from "./detectors/decompiler/index.ts";
import { hardToAnalyzeDetectorPlugin } from "./detectors/hard-to-analyze/index.ts";

// Typed startup errors (P-02, P-08). Each error names the plugin id, and
// the version error names both versions, with values kept outside the
// error text where they could carry secrets (P-01). A manifest without
// a bound implementation fails here, at startup, instead of degrading per
// analysis.
export type PluginRegistryError =
  | { kind: "duplicate-plugin-id"; pluginId: string; message: string }
  | {
      kind: "unsupported-api-version";
      pluginId: string;
      apiVersion: string;
      supportedApiVersion: string;
      message: string;
    }
  | { kind: "unsupported-capability"; pluginId: string; capability: string; message: string }
  | { kind: "missing-plugin-implementation"; pluginId: string; message: string };

export type PluginRegistry = {
  readonly entries: readonly DetectorPlugin[];
};

export type AssessmentRegistry = {
  readonly entries: readonly AssessmentPlugin[];
};

function checkDetectorEntry(
  entry: DetectorPlugin,
  seen: Set<string>,
): PluginRegistryError | null {
  if (entry === null || typeof entry !== "object") {
    return {
      kind: "missing-plugin-implementation",
      pluginId: "unknown",
      message: "a registry entry without an implementation cannot start",
    };
  }
  const manifest: unknown = (entry as { manifest?: unknown }).manifest;
  if (!isDetectorManifest(manifest)) {
    return {
      kind: "missing-plugin-implementation",
      pluginId: "unknown",
      message: "a registry entry without an implementation cannot start",
    };
  }
  if (typeof (entry as { detect?: unknown }).detect !== "function") {
    return {
      kind: "missing-plugin-implementation",
      pluginId: manifest.id,
      message: `registered detector ${manifest.id} carries no implementation, which startup turns away`,
    };
  }
  if (seen.has(manifest.id)) {
    return {
      kind: "duplicate-plugin-id",
      pluginId: manifest.id,
      message: `duplicate plugin id in the registry: ${manifest.id}`,
    };
  }
  seen.add(manifest.id);
  if (!isSupportedApiVersion(manifest.apiVersion)) {
    return {
      kind: "unsupported-api-version",
      pluginId: manifest.id,
      apiVersion: manifest.apiVersion,
      supportedApiVersion: PLUGIN_API_VERSION,
      message: `plugin ${manifest.id} targets api ${manifest.apiVersion}, supported range is major ${PLUGIN_API_VERSION} with minor at most the core minor`,
    };
  }
  if (manifest.capabilities.needsNetwork) {
    return {
      kind: "unsupported-capability",
      pluginId: manifest.id,
      capability: "needsNetwork",
      message: `detector plugin ${manifest.id} declares network capability, which startup turns away`,
    };
  }
  if (manifest.capabilities.needsSecrets) {
    return {
      kind: "unsupported-capability",
      pluginId: manifest.id,
      capability: "needsSecrets",
      message: `detector plugin ${manifest.id} declares secret capability, which startup turns away`,
    };
  }
  return null;
}

function isDetectorManifest(value: unknown): value is DetectorManifest {
  if (value === null || typeof value !== "object") {
    return false;
  }
  const manifest = value as { kind?: unknown };
  return manifest.kind === "detector";
}

// Validates the registry entry set at startup (P-08): one implementation
// per entry, unique plugin ids, one supported apiVersion range per plugin
// (P-02) and kind-default capabilities per plugin (detector plugins hold
// zero network and zero secret capability, P-03; the smart constructor
// already rejects those values, and this re-check is defence in depth
// over entries the constructor did not parse). The returned registry is
// frozen and sorted by plugin id.
export function buildPluginRegistry(
  entries: readonly DetectorPlugin[],
): Result<PluginRegistry, PluginRegistryError> {
  const seen = new Set<string>();
  for (const entry of entries) {
    const failure = checkDetectorEntry(entry, seen);
    if (failure !== null) {
      return err(failure);
    }
  }
  const sorted = [...entries].sort((left, right) => {
    if (left.manifest.id < right.manifest.id) {
      return -1;
    }
    if (left.manifest.id > right.manifest.id) {
      return 1;
    }
    return 0;
  });
  return ok(Object.freeze({ entries: Object.freeze(sorted) }));
}

// Validates the assessment entry set at startup: unique plugin ids and
// one supported apiVersion range per plugin (P-02, P-04). The returned
// registry is frozen and sorted by plugin id.
export function buildAssessmentRegistry(
  entries: readonly AssessmentPlugin[],
): Result<AssessmentRegistry, PluginRegistryError> {
  const seen = new Set<string>();
  for (const entry of entries) {
    const manifest = entry.manifest;
    if (seen.has(manifest.id)) {
      return err({
        kind: "duplicate-plugin-id",
        pluginId: manifest.id,
        message: `duplicate plugin id in the registry: ${manifest.id}`,
      });
    }
    seen.add(manifest.id);
    if (!isSupportedApiVersion(manifest.apiVersion)) {
      return err({
        kind: "unsupported-api-version",
        pluginId: manifest.id,
        apiVersion: manifest.apiVersion,
        supportedApiVersion: PLUGIN_API_VERSION,
        message: `plugin ${manifest.id} targets api ${manifest.apiVersion}, supported range is major ${PLUGIN_API_VERSION} with minor at most the core minor`,
      });
    }
  }
  const sorted = [...entries].sort((left, right) => {
    if (left.manifest.id < right.manifest.id) {
      return -1;
    }
    if (left.manifest.id > right.manifest.id) {
      return 1;
    }
    return 0;
  });
  return ok(Object.freeze({ entries: Object.freeze(sorted) }));
}

// The empty detector registry: validated through the same builder, so the
// composition root starts from a checked value. Building the empty set
// cannot fail; the fallback below is unreachable by construction.
export function createEmptyPluginRegistry(): PluginRegistry {
  const built = buildPluginRegistry([]);
  if (!built.ok) {
    return Object.freeze({ entries: Object.freeze([]) });
  }
  return built.value;
}

// Registry lookup for execution dispatch: solely registered entries run,
// so a plugin absent from the registry never runs.
export function getPlugin(registry: PluginRegistry, id: string): DetectorPlugin | undefined {
  return registry.entries.find((entry) => entry.manifest.id === id);
}

// First-party assessment set (S-045, P-12 step 3): the Meta Model API
// adapter and the hosted open-weights adapter register as assessment
// plugins wrapping their existing AssessmentModelPort implementations.
// The list is a frozen static array; configuration selects exactly one of
// them as the active plugin by plugin id and never names code to load
// (P-07).
export const ASSESSMENT_PLUGINS: readonly AssessmentPlugin[] = Object.freeze([
  metaModelApiAssessmentPlugin,
  hostedOpenWeightsAssessmentPlugin,
]);

// The validated assessment registry: built through the same startup
// builder, so a bad assessment entry fails fast with its typed error
// instead of reaching any selection. The composition root maps a builder
// failure to a typed startup error; nothing here throws at module load.
export function buildDefaultAssessmentRegistry(): Result<
  AssessmentRegistry,
  PluginRegistryError
> {
  return buildAssessmentRegistry(ASSESSMENT_PLUGINS);
}

export function registeredPluginIds(registry: PluginRegistry): readonly PluginId[] {
  return registry.entries.map((entry) => entry.manifest.id);
}

// First-party detector set (S-043, P-12 step 1; S-044, P-12 step 2; S-081,
// D-07): the capability detector is the first registered detector plugin,
// followed by the clone-match, decompiler and hard-to-analyze detectors.
// The list is a frozen
// static value; configuration selects among registered entries only and
// never names code to load (P-07). Each entry carries its manifest beside
// its implementation, so a manifest without an implementation is
// unrepresentable past the startup builder above.
export const DEFAULT_DETECTOR_PLUGINS: readonly DetectorPlugin[] = Object.freeze([
  capabilityDetectorPlugin,
  cloneMatchDetectorPlugin,
  decompilerDetectorPlugin,
  hardToAnalyzeDetectorPlugin,
]);
