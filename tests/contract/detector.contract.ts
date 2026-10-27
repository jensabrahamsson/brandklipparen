// Shared contract suite for detector plugins (S-043, K-029 proposed, P-03).
// Every detector plugin runs this same suite on frozen inputs: two runs give
// bit-identical canonical output, the typed output agrees with the manifest
// outputSchema in both directions, every finding carries evidence with a
// namespaced id, and the frozen input value is unchanged after detect.
import { describe, expect, test } from "vitest";
import { canonicalSerialize } from "../../src/domain/serialize.ts";
import { validatePluginOutput } from "../../src/plugins/detector.ts";
import type { DetectorInput, DetectorPlugin } from "../../src/plugins/detector.ts";

function toPlain(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value)) as unknown;
}

function requiredItemKeys(plugin: DetectorPlugin): string[] {
  const schema = plugin.manifest.outputSchema as Readonly<Record<string, unknown>>;
  const items = schema["items"];
  if (typeof items !== "object" || items === null || Array.isArray(items)) {
    return [];
  }
  const required = (items as Readonly<Record<string, unknown>>)["required"];
  if (!Array.isArray(required) || !required.every((entry) => typeof entry === "string")) {
    return [];
  }
  return [...(required as string[])];
}

export function runDetectorPluginContract(
  label: string,
  plugin: DetectorPlugin,
  makeInput: () => DetectorInput,
): void {
  describe(`Detector plugin contract: ${label}`, () => {
    test("determinism across two runs with identical canonical output", () => {
      const first = plugin.detect(makeInput());
      const second = plugin.detect(makeInput());
      expect(canonicalSerialize(first as never)).toBe(canonicalSerialize(second as never));
    });

    test("typed output agrees with the manifest outputSchema in both directions", () => {
      const findings = plugin.detect(makeInput());
      expect(validatePluginOutput(toPlain(findings), plugin.manifest.outputSchema)).toBe(true);
      const first = (findings as ReadonlyArray<Readonly<Record<string, unknown>>>)[0];
      if (first === undefined) {
        return;
      }
      for (const key of requiredItemKeys(plugin)) {
        const dropped = { ...first };
        delete dropped[key];
        expect(validatePluginOutput(toPlain([dropped]), plugin.manifest.outputSchema)).toBe(false);
      }
    });

    test("every finding carries evidence and a namespaced id", () => {
      const findings = plugin.detect(makeInput());
      expect(findings.length).toBeGreaterThan(0);
      for (const finding of findings) {
        expect(finding.id.startsWith(`${plugin.manifest.id}:`)).toBe(true);
        expect(finding.pluginId).toBe(plugin.manifest.id);
        expect(finding.title.trim().length).toBeGreaterThan(0);
        expect(finding.evidence.length).toBeGreaterThan(0);
        for (const entry of finding.evidence) {
          expect(entry.selector as string).toMatch(/^0x[0-9a-f]{8}$/);
        }
      }
    });

    test("inputs are unchanged after detect", () => {
      const input = makeInput();
      const before = JSON.stringify(input);
      plugin.detect(input);
      expect(JSON.stringify(input)).toBe(before);
    });
  });
}
