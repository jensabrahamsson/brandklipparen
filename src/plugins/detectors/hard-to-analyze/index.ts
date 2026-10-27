// Hard-to-analyze detector plugin `dev.brandklipparen.hard-to-analyze`
// (S-044, P-12 step 2). First-party detector behind the registry: the host
// derives the decompiler failure cause through DecompilerPort and hands it
// over as the `decompilerCause` input fact, and the plugin reports it with
// selector evidence at weight 0. A null cause yields no findings, so a
// successful decompilation stays silent. The application service maps the
// finding to today's hard-to-analyze Signal through the frozen placeholder
// risk, so scores stay bit-identical until calibration names the finding
// (P-05). Pure and synchronous: this module imports solely the plugin API
// and domain types and pure functions (P-03).
import { Evidence } from "../../../domain/evidence.ts";
import type { Evidence as EvidenceType, NonEmpty } from "../../../domain/evidence.ts";
import { extractSelectors } from "../../../domain/selectors.ts";
import { HARD_TO_ANALYZE_CAUSES } from "../../../domain/signals.ts";
import { PLUGIN_API_VERSION, PluginManifest } from "../../api.ts";
import type { DetectorInput, DetectorPlugin, PluginFinding } from "../../detector.ts";

const PLUGIN_ID = "dev.brandklipparen.hard-to-analyze";

// Output schema descriptor for the finding list (ADR section 3.3): the
// draft-07 subset the registry documents. The contract suite checks the
// typed output and this descriptor against each other in both directions.
const OUTPUT_SCHEMA = Object.freeze({
  type: "array",
  maxItems: 1,
  items: Object.freeze({
    type: "object",
    required: Object.freeze(["id", "pluginId", "title", "payload", "evidence"]),
    properties: Object.freeze({
      id: Object.freeze({ type: "string", minLength: 1 }),
      pluginId: Object.freeze({ const: PLUGIN_ID }),
      title: Object.freeze({ type: "string", minLength: 1 }),
      payload: Object.freeze({
        type: "object",
        required: Object.freeze(["cause"]),
        properties: Object.freeze({
          cause: Object.freeze({ enum: Object.freeze([...HARD_TO_ANALYZE_CAUSES]) }),
        }),
        additionalProperties: false,
      }),
      evidence: Object.freeze({
        type: "array",
        minItems: 1,
        items: Object.freeze({
          type: "object",
          required: Object.freeze(["selector"]),
          properties: Object.freeze({
            selector: Object.freeze({ type: "string", minLength: 1 }),
            offset: Object.freeze({ type: Object.freeze(["integer", "null"]), minimum: 0 }),
          }),
          additionalProperties: false,
        }),
      }),
    }),
    additionalProperties: false,
  }),
});

function manifestOf(): DetectorPlugin["manifest"] {
  const parsed = PluginManifest.parse({
    id: PLUGIN_ID,
    version: "1.0.0",
    kind: "detector",
    apiVersion: PLUGIN_API_VERSION,
    displayName: "Hard-to-analyze detector",
    description: "Reports a failed decompilation cause with selector evidence.",
    inputs: ["bytecode"],
    outputSchema: OUTPUT_SCHEMA,
    capabilities: {},
    limits: { maxFindings: 1, maxEvidencePerFinding: 8, maxOutputBytes: 32768 },
  });
  if (!parsed.ok) {
    throw new Error(`hard-to-analyze plugin manifest failed validation: ${parsed.error.kind}`);
  }
  return parsed.value;
}

function toNonEmpty(items: EvidenceType[]): NonEmpty<EvidenceType> | null {
  const first = items[0];
  if (first === undefined) {
    return null;
  }
  return Object.freeze([first, ...items.slice(1)]) as NonEmpty<EvidenceType>;
}

// Decompiler-failure reporting over the frozen input. Total: arbitrary
// input yields a finding list, never an exception. A null cause yields no
// findings, and bytecode without selectors yields no findings, since a
// finding without selector evidence is unrepresentable. The evidence
// mirrors the legacy fallback signal entry for entry: the first dispatcher
// selector, so the host conversion reproduces the same Signal.
function detect(input: DetectorInput): readonly PluginFinding[] {
  const cause = input.decompilerCause ?? null;
  if (cause === null) {
    return Object.freeze([]);
  }
  const first = extractSelectors(input.bytecode)[0];
  if (first === undefined) {
    return Object.freeze([]);
  }
  const evidence = Evidence.create({ selector: first.selector });
  if (!evidence.ok) {
    return Object.freeze([]);
  }
  const nonEmpty = toNonEmpty([evidence.value]);
  if (nonEmpty === null) {
    return Object.freeze([]);
  }
  return Object.freeze([
    Object.freeze({
      id: `${PLUGIN_ID}:${cause}`,
      pluginId: MANIFEST.id,
      title: `Contract is hard to analyze: ${cause}`,
      evidence: nonEmpty,
      payload: Object.freeze({ cause }),
    }),
  ]);
}

const MANIFEST = manifestOf();

export const hardToAnalyzeDetectorPlugin: DetectorPlugin = Object.freeze({
  manifest: MANIFEST,
  detect,
});
