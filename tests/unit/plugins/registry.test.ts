// Tests for S-042 (K-028 and K-514 proposed): the static plugin registry.
// Written first (red) per A-21; the implementation lives in
// src/plugins/registry.ts with manifest types in src/plugins/api.ts.
// The registry starts empty beside the existing path (ADR P-12 step 0):
// it validates every manifest at startup and runs solely registered code.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { PluginManifest } from "../../../src/plugins/api.ts";
import {
  buildPluginRegistry,
  createEmptyPluginRegistry,
  getPlugin,
  registeredPluginIds,
} from "../../../src/plugins/registry.ts";
import type { PluginManifest as PluginManifestValue } from "../../../src/plugins/api.ts";
import { EMPTY_PLUGIN_REGISTRY } from "../../../src/composition/root.ts";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

function parseManifest(overrides: Record<string, unknown> = {}): PluginManifestValue {
  const parsed = PluginManifest.parse({
    id: "dev.brandklipparen.capability",
    version: "1.0.0",
    kind: "detector",
    apiVersion: "1.0.0",
    displayName: "Capability detector",
    description: "Reports owner capabilities with selector evidence.",
    inputs: ["selectors"],
    outputSchema: { type: "object", additionalProperties: false },
    capabilities: {},
    limits: { maxFindings: 50, maxEvidencePerFinding: 4, maxOutputBytes: 32768 },
    ...overrides,
  });
  if (!parsed.ok) {
    throw new Error(`test manifest failed to parse: ${parsed.error.kind} ${parsed.error.message}`);
  }
  return parsed.value;
}

function sourceFiles(directory: string): string[] {
  return readdirSync(directory)
    .map((entry) => join(directory, entry))
    .flatMap((path) => (statSync(path).isDirectory() ? sourceFiles(path) : [path]))
    .filter((path) => path.endsWith(".ts"));
}

describe("static plugin registry", () => {
  test("registry_rejects_duplicate_ids_and_unsupported_api_versions", () => {
    const first = parseManifest();
    const duplicate = parseManifest({ version: "2.0.0" });
    const duplicates = buildPluginRegistry([first, duplicate]);
    expect(duplicates.ok).toBe(false);
    if (duplicates.ok) {
      throw new Error("expected a duplicate plugin id error");
    }
    expect(duplicates.error.kind).toBe("duplicate-plugin-id");
    expect(duplicates.error.pluginId).toBe("dev.brandklipparen.capability");

    for (const apiVersion of ["0.9.0", "1.1.0", "2.0.0"]) {
      const ranged = buildPluginRegistry([parseManifest({ apiVersion })]);
      expect(ranged.ok).toBe(false);
      if (ranged.ok) {
        throw new Error(`expected an unsupported api version error for ${apiVersion}`);
      }
      expect(ranged.error.kind).toBe("unsupported-api-version");
      expect(ranged.error.pluginId).toBe("dev.brandklipparen.capability");
    }

    const violating = buildPluginRegistry([
      parseManifest({ capabilities: { needsNetwork: true } }),
    ]);
    expect(violating.ok).toBe(false);
    if (violating.ok) {
      throw new Error("expected an unsupported capability error");
    }
    expect(violating.error.kind).toBe("unsupported-capability");

    const clean = buildPluginRegistry([
      parseManifest(),
      parseManifest({ id: "dev.brandklipparen.clone-match", apiVersion: "1.0.5" }),
    ]);
    expect(clean.ok).toBe(true);
  });

  test("k514_registry_has_no_dynamic_loading", () => {
    // P-07: registration is static and compile-time. The registry package
    // and the composition root hold no dynamic code loading, no directory
    // scan and no environment-named module path for plugin code.
    const scanned = [...sourceFiles(join(repoRoot, "src", "plugins"))];
    const composition = join(repoRoot, "src", "composition");
    scanned.push(...sourceFiles(composition));
    expect(scanned.length).toBeGreaterThan(0);
    const forbidden: ReadonlyArray<readonly [RegExp, string]> = [
      [/\bimport\s*\(/, "dynamic import"],
      [/\brequire\s*\(/, "require call"],
      [/\bcreateRequire\s*\(/, "module creation from a path"],
      [/\breaddir|\bopendir/, "directory scan"],
      [/\bprocess\.env\b/, "environment-named module path"],
    ];
    const hits: string[] = [];
    for (const file of scanned) {
      const text = readFileSync(file, "utf8");
      for (const [pattern, label] of forbidden) {
        if (pattern.test(text)) {
          hits.push(`${relative(repoRoot, file)}: ${label}`);
        }
      }
    }
    expect(hits).toEqual([]);
  });

  test("k514_unregistered_plugin_never_runs", () => {
    // Solely registered plugins are returned for execution: a plugin
    // absent from the registry array is absent from every lookup.
    const registered = parseManifest();
    const built = buildPluginRegistry([registered]);
    if (!built.ok) {
      throw new Error("expected the registry to build");
    }
    const registry = built.value;
    expect(registeredPluginIds(registry)).toEqual(["dev.brandklipparen.capability"]);
    expect(getPlugin(registry, "dev.brandklipparen.capability")).toBe(registered);
    expect(getPlugin(registry, "dev.brandklipparen.absent")).toBe(undefined);
    expect(registeredPluginIds(registry)).not.toContain("dev.brandklipparen.absent");
  });

  test("registry_builds_empty_and_freezes_through_the_composition_root", () => {
    const empty = createEmptyPluginRegistry();
    expect(empty.plugins).toEqual([]);
    expect(Object.isFrozen(empty)).toBe(true);
    expect(EMPTY_PLUGIN_REGISTRY.plugins).toEqual([]);
  });
});
