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
import type { DetectorManifest } from "../../../src/plugins/api.ts";
import {
  buildPluginRegistry,
  createEmptyPluginRegistry,
  getPlugin,
  registeredPluginIds,
} from "../../../src/plugins/registry.ts";
import type { DetectorPlugin } from "../../../src/plugins/detector.ts";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

function parseManifest(overrides: Record<string, unknown> = {}): DetectorManifest {
  const parsed = PluginManifest.parse({
    id: "dev.brandklipparen.capability",
    version: "1.0.0",
    kind: "detector",
    apiVersion: "1.0.0",
    displayName: "Capability detector",
    description: "Reports owner capabilities with selector evidence.",
    inputs: ["bytecode"],
    docs: "PLUGIN.md",
    outputSchema: { type: "object", additionalProperties: false },
    capabilities: {},
    limits: { maxFindings: 50, maxEvidencePerFinding: 4, maxOutputBytes: 32768 },
    ...overrides,
  });
  if (!parsed.ok) {
    throw new Error(`test manifest failed to parse: ${parsed.error.kind} ${parsed.error.message}`);
  }
  if (parsed.value.kind !== "detector") {
    throw new Error("test manifest carries the wrong kind");
  }
  return parsed.value;
}

function testEntry(overrides: Record<string, unknown> = {}): DetectorPlugin {
  return Object.freeze({
    manifest: parseManifest(overrides),
    detect: () => Object.freeze([]),
  });
}

function sourceFiles(directory: string): string[] {
  return readdirSync(directory)
    .map((entry) => join(directory, entry))
    .flatMap((path) => (statSync(path).isDirectory() ? sourceFiles(path) : [path]))
    .filter((path) => path.endsWith(".ts"));
}

describe("static plugin registry", () => {
  test("registry_rejects_duplicate_ids_and_unsupported_api_versions", () => {
    const first = testEntry();
    const duplicate = testEntry({ version: "2.0.0" });
    const duplicates = buildPluginRegistry([first, duplicate]);
    expect(duplicates.ok).toBe(false);
    if (duplicates.ok) {
      throw new Error("expected a duplicate plugin id error");
    }
    expect(duplicates.error.kind).toBe("duplicate-plugin-id");
    expect(duplicates.error.pluginId).toBe("dev.brandklipparen.capability");

    for (const apiVersion of ["0.9.0", "1.1.0", "2.0.0"]) {
      const ranged = buildPluginRegistry([testEntry({ apiVersion })]);
      expect(ranged.ok).toBe(false);
      if (ranged.ok) {
        throw new Error(`expected an unsupported api version error for ${apiVersion}`);
      }
      expect(ranged.error.kind).toBe("unsupported-api-version");
      expect(ranged.error.pluginId).toBe("dev.brandklipparen.capability");
    }

    // The smart constructor already rejects detector network capability,
    // so the registry re-check is defence in depth over an entry it did
    // not parse itself.
    const networked = {
      manifest: {
        ...parseManifest(),
        capabilities: { ...parseManifest().capabilities, needsNetwork: true },
      },
      detect: () => Object.freeze([]),
    } as unknown as DetectorPlugin;
    const violating = buildPluginRegistry([networked]);
    expect(violating.ok).toBe(false);
    if (violating.ok) {
      throw new Error("expected an unsupported capability error");
    }
    expect(violating.error.kind).toBe("unsupported-capability");

    const missing = buildPluginRegistry([
      { manifest: parseManifest() } as unknown as DetectorPlugin,
    ]);
    expect(missing.ok).toBe(false);
    if (missing.ok) {
      throw new Error("expected a missing implementation error");
    }
    expect(missing.error.kind).toBe("missing-plugin-implementation");
    expect(missing.error.pluginId).toBe("dev.brandklipparen.capability");

    const clean = buildPluginRegistry([
      testEntry(),
      testEntry({ id: "dev.brandklipparen.clone-match", apiVersion: "1.0.5" }),
    ]);
    expect(clean.ok).toBe(true);
    if (!clean.ok) {
      throw new Error("expected the clean registry to build");
    }
    expect(clean.value.entries.map((entry) => entry.manifest.id)).toEqual([
      "dev.brandklipparen.capability",
      "dev.brandklipparen.clone-match",
    ]);
    expect(Object.isFrozen(clean.value)).toBe(true);
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
    // Solely registered entries are returned for execution: a plugin
    // absent from the registry entries is absent from every lookup.
    const registered = testEntry();
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

  test("registry_builds_empty_and_freezes", () => {
    const empty = createEmptyPluginRegistry();
    expect(empty.entries).toEqual([]);
    expect(Object.isFrozen(empty)).toBe(true);
    expect(Object.isFrozen(empty.entries)).toBe(true);
  });
});
