// Decompiler detector plugin `dev.brandklipparen.decompiler` (S-081,
// D-07, D-08). First-party detector behind the registry: the own
// deterministic ERC-20 pipeline (`decompileContract` over the frozen
// detector input bytecode) reports one finding per dispatcher function
// entry with selector and entry-PC evidence at weight 0. The application
// service maps no decompiler payload key to a Signal, so scores,
// probabilities and signals stay bit-identical until the calibration
// artifact names this plugin (P-05). Pure and synchronous: this module
// imports solely the plugin API and domain types and pure functions (P-03).
import { Evidence } from "../../../domain/evidence.ts";
import type { Evidence as EvidenceType, NonEmpty } from "../../../domain/evidence.ts";
import { decompileContract } from "../../../domain/evmSsa.ts";
import { PcOffset, Selector } from "../../../domain/types.ts";
import { PLUGIN_API_VERSION, PluginManifest } from "../../api.ts";
import type { DetectorInput, DetectorPlugin, PluginFinding } from "../../detector.ts";

const PLUGIN_ID = "dev.brandklipparen.decompiler";

// Output schema descriptor for the finding list (ADR section 3.3): the
// draft-07 subset the registry documents. The contract suite checks the
// typed output and this descriptor against each other in both directions.
const OUTPUT_SCHEMA = Object.freeze({
  type: "array",
  maxItems: 64,
  items: Object.freeze({
    type: "object",
    required: Object.freeze(["id", "pluginId", "title", "payload", "evidence"]),
    properties: Object.freeze({
      id: Object.freeze({ type: "string", minLength: 1 }),
      pluginId: Object.freeze({ const: PLUGIN_ID }),
      title: Object.freeze({ type: "string", minLength: 1 }),
      payload: Object.freeze({
        type: "object",
        required: Object.freeze([
          "selector",
          "name",
          "entryPc",
          "startPc",
          "endPc",
          "annotations",
          "cause",
          "unresolvedJumps",
        ]),
        properties: Object.freeze({
          selector: Object.freeze({ type: "string", minLength: 1 }),
          name: Object.freeze({ type: "string", minLength: 1 }),
          signature: Object.freeze({ type: Object.freeze(["string", "null"]) }),
          entryPc: Object.freeze({ type: "integer", minimum: 0 }),
          startPc: Object.freeze({ type: "integer", minimum: 0 }),
          endPc: Object.freeze({ type: "integer", minimum: 0 }),
          annotations: Object.freeze({
            type: "array",
            items: Object.freeze({ type: "string" }),
          }),
          cause: Object.freeze({ type: Object.freeze(["string", "null"]) }),
          unresolvedJumps: Object.freeze({ type: "integer", minimum: 0 }),
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
    displayName: "Decompiler detector",
    description: "Reports one finding per decompiled ERC-20 function with exact bytecode ranges.",
    inputs: ["bytecode"],
    docs: "PLUGIN.md",
    outputSchema: OUTPUT_SCHEMA,
    capabilities: {},
    limits: { maxFindings: 64, maxEvidencePerFinding: 4, maxOutputBytes: 32768 },
  });
  if (!parsed.ok) {
    throw new Error(`decompiler plugin manifest failed validation: ${parsed.error.kind}`);
  }
  if (parsed.value.kind !== "detector") {
    throw new Error(
      `decompiler plugin manifest carries kind ${parsed.value.kind}, expected detector`,
    );
  }
  return parsed.value;
}

// Own-pipeline detection over the frozen input. Total: any bytecode yields
// a finding list, never an exception; functions whose selector or entry PC
// fails domain construction are skipped so the registry boundary keeps a
// proven-evidence list. Deterministic: entry order from the pipeline,
// final sort on the namespaced finding id. Bytecode without dispatcher
// entries yields no findings, since a finding without evidence is
// unrepresentable. The payload carries no `capability` key, so the host
// conversion leaves these findings as weight-0 display records.
function detect(input: DetectorInput): readonly PluginFinding[] {
  const decompiled = decompileContract(input.bytecode);
  const unresolvedJumps = decompiled.unresolvedJumps.length;
  const out: PluginFinding[] = [];
  for (const fn of decompiled.functions) {
    const selector = Selector.parse(fn.selector);
    if (!selector.ok) {
      continue;
    }
    const offset = PcOffset.of(fn.entryPc, input.bytecode);
    if (!offset.ok) {
      continue;
    }
    const evidence: EvidenceType[] = [];
    const created = Evidence.create({ selector: selector.value, offset: offset.value });
    if (!created.ok) {
      continue;
    }
    evidence.push(created.value);
    const proven = Object.freeze([evidence[0] as EvidenceType]) as NonEmpty<EvidenceType>;
    out.push(
      Object.freeze({
        id: `${PLUGIN_ID}:${fn.selector}`,
        pluginId: MANIFEST.id,
        title: `Decompiled function ${fn.name} (${fn.selector})`,
        evidence: proven,
        payload: Object.freeze({
          selector: fn.selector,
          name: fn.name,
          signature: fn.signature,
          entryPc: fn.entryPc,
          startPc: fn.range.startPc,
          endPc: fn.range.endPc,
          annotations: Object.freeze([...fn.annotations]),
          cause: fn.cause,
          unresolvedJumps,
        }),
      }),
    );
  }
  out.sort((left, right) => {
    if (left.id < right.id) {
      return -1;
    }
    if (left.id > right.id) {
      return 1;
    }
    return 0;
  });
  return Object.freeze(out);
}

const MANIFEST = manifestOf();

export const decompilerDetectorPlugin: DetectorPlugin = Object.freeze({
  manifest: MANIFEST,
  detect,
});
