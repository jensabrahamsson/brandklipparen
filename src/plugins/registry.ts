// Static plugin registry (S-042, P-07, P-08).
// The registry is a frozen array assembled from static values and handed
// to the composition root, which stays the single module that knows
// concrete plugin modules (A-03). No computed module path, no directory
// scan and no configuration-named code path exists in the registry path:
// configuration selects among already-registered plugins only. In S-042
// the registry starts empty beside the existing path (ADR P-12 step 0),
// so analysis output stays unchanged until the S-043 migration.
import { err, ok } from "../domain/result.ts";
import type { Result } from "../domain/result.ts";
import { PLUGIN_API_VERSION, isSupportedApiVersion } from "./api.ts";
import type { PluginId, PluginManifest } from "./api.ts";

// Typed startup errors (P-02, P-08). Each error names the plugin id, and
// the version error names both versions, with values kept outside the
// error text where they could carry secrets (P-01).
export type PluginRegistryError =
  | { kind: "duplicate-plugin-id"; pluginId: string; message: string }
  | {
      kind: "unsupported-api-version";
      pluginId: string;
      apiVersion: string;
      supportedApiVersion: string;
      message: string;
    }
  | { kind: "unsupported-capability"; pluginId: string; capability: string; message: string };

export type PluginRegistry = {
  readonly plugins: readonly PluginManifest[];
};

// Validates the registry at startup (P-08): unique plugin ids, one
// supported apiVersion range per plugin (P-02) and kind-default
// capabilities per plugin (detector plugins hold zero network and zero
// secret capability, P-03). The returned registry is frozen.
export function buildPluginRegistry(
  manifests: readonly PluginManifest[],
): Result<PluginRegistry, PluginRegistryError> {
  const seen = new Set<string>();
  for (const manifest of manifests) {
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
    if (manifest.kind === "detector" && manifest.capabilities.needsNetwork) {
      return err({
        kind: "unsupported-capability",
        pluginId: manifest.id,
        capability: "needsNetwork",
        message: `detector plugin ${manifest.id} declares network capability, which startup turns away`,
      });
    }
    if (manifest.kind === "detector" && manifest.capabilities.needsSecrets) {
      return err({
        kind: "unsupported-capability",
        pluginId: manifest.id,
        capability: "needsSecrets",
        message: `detector plugin ${manifest.id} declares secret capability, which startup turns away`,
      });
    }
  }
  return ok(Object.freeze({ plugins: Object.freeze([...manifests]) }));
}

// The empty S-042 registry: validated through the same builder, so the
// composition root starts from a checked value from the first story.
export function createEmptyPluginRegistry(): PluginRegistry {
  const built = buildPluginRegistry([]);
  if (!built.ok) {
    throw new Error(`empty plugin registry failed validation: ${built.error.kind}`);
  }
  return built.value;
}

// Registry lookup for execution dispatch: solely registered plugins are
// returned, so a plugin absent from the registry array never runs.
export function getPlugin(
  registry: PluginRegistry,
  id: string,
): PluginManifest | undefined {
  return registry.plugins.find((manifest) => manifest.id === id);
}

export function registeredPluginIds(registry: PluginRegistry): readonly PluginId[] {
  return registry.plugins.map((manifest) => manifest.id);
}
