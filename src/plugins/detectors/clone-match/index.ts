// Clone-match detector plugin `dev.brandklipparen.clone-match` (S-044,
// P-12 step 2). First-party detector behind the registry: the template hit
// the host looked up through CloneIndexPort arrives as the `cloneMatch`
// input fact, and the plugin reports it with selector evidence at weight 0.
// The application service maps the finding to today's clone-match Signal
// through the versioned clone mapping, so scores stay bit-identical until
// calibration names the finding (P-05). Pure and synchronous: this module
// imports solely the plugin API and domain types and pure functions (P-03).
import { Evidence } from "../../../domain/evidence.ts";
import type { Evidence as EvidenceType, NonEmpty } from "../../../domain/evidence.ts";
import { extractSelectors } from "../../../domain/selectors.ts";
import { PLUGIN_API_VERSION, PluginManifest } from "../../api.ts";
import type { DetectorInput, DetectorPlugin, PluginFinding } from "../../detector.ts";

const PLUGIN_ID = "dev.brandklipparen.clone-match";

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
        required: Object.freeze(["similarity", "group", "priorCount"]),
        properties: Object.freeze({
          similarity: Object.freeze({ type: "number", minimum: 0, maximum: 1 }),
          group: Object.freeze({ type: "string", minLength: 1 }),
          priorCount: Object.freeze({ type: "integer", minimum: 0 }),
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
    displayName: "Clone-match detector",
    description: "Reports a known trap-template hit with selector evidence.",
    inputs: ["bytecode", "cloneMatch"],
    outputSchema: OUTPUT_SCHEMA,
    capabilities: {},
    limits: { maxFindings: 1, maxEvidencePerFinding: 8, maxOutputBytes: 32768 },
  });
  if (!parsed.ok) {
    throw new Error(`clone-match plugin manifest failed validation: ${parsed.error.kind}`);
  }
  if (parsed.value.kind !== "detector") {
    throw new Error(
      `clone-match plugin manifest carries kind ${parsed.value.kind}, expected detector`,
    );
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

// Clone-hit reporting over the frozen input. Total: arbitrary input yields
// a finding list, never an exception. A null hit yields no findings, and
// bytecode without selectors yields no findings, since a finding without
// selector evidence is unrepresentable. The evidence mirrors the legacy
// domain signal entry for entry: the first extracted selector with its
// derivable PC offset, so the host conversion reproduces the same Signal.
function detect(input: DetectorInput): readonly PluginFinding[] {
  const hit = input.cloneMatch ?? null;
  if (hit === null) {
    return Object.freeze([]);
  }
  const entries = extractSelectors(input.bytecode);
  const first = entries[0];
  if (first === undefined) {
    return Object.freeze([]);
  }
  const evidence =
    first.kind === "paired"
      ? Evidence.create({ selector: first.selector, offset: first.target })
      : Evidence.create({ selector: first.selector });
  if (!evidence.ok) {
    return Object.freeze([]);
  }
  const nonEmpty = toNonEmpty([evidence.value]);
  if (nonEmpty === null) {
    return Object.freeze([]);
  }
  const group = hit.group as string;
  return Object.freeze([
    Object.freeze({
      id: `${PLUGIN_ID}:${group}`,
      pluginId: MANIFEST.id,
      title: `Token matches known clone group ${group}`,
      evidence: nonEmpty,
      payload: Object.freeze({
        similarity: hit.similarity as number,
        group,
        priorCount: hit.priorCount,
      }),
    }),
  ]);
}

const MANIFEST = manifestOf();

export const cloneMatchDetectorPlugin: DetectorPlugin = Object.freeze({
  manifest: MANIFEST,
  detect,
});
