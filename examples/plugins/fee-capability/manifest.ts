// Example third-party-style fee-capability detector (S-051): manifest.
// Written after the failing tests per A-21. The manifest is the single
// contract per plugin (P-01): id, version, kind, apiVersion, display name,
// description, declared inputs, output schema, capabilities and limits,
// validated by the PluginManifest smart constructor. The example is a
// local fixture only: nothing registers it in the production default
// registry, and it imports solely the plugin API (P-03).
import { PLUGIN_API_VERSION, PluginManifest } from "../../../src/plugins/api.ts";
import type { DetectorManifest } from "../../../src/plugins/api.ts";

export const FEE_CAPABILITY_PLUGIN_ID = "dev.brandklipparen.example-fee-capability";

// Output schema descriptor for the finding list (ADR section 3.3): the
// draft-07 subset the registry documents. The contract suite checks the
// typed output and this descriptor against each other in both directions.
const OUTPUT_SCHEMA = Object.freeze({
  type: "array",
  maxItems: 8,
  items: Object.freeze({
    type: "object",
    required: Object.freeze(["id", "pluginId", "title", "payload", "evidence"]),
    properties: Object.freeze({
      id: Object.freeze({ type: "string", minLength: 1 }),
      pluginId: Object.freeze({ const: FEE_CAPABILITY_PLUGIN_ID }),
      title: Object.freeze({ type: "string", minLength: 1 }),
      payload: Object.freeze({
        type: "object",
        required: Object.freeze(["selector", "name"]),
        properties: Object.freeze({
          selector: Object.freeze({ type: "string", minLength: 1 }),
          name: Object.freeze({ type: "string", minLength: 1 }),
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

function manifestOf(): DetectorManifest {
  const parsed = PluginManifest.parse({
    id: FEE_CAPABILITY_PLUGIN_ID,
    version: "1.0.0",
    kind: "detector",
    apiVersion: PLUGIN_API_VERSION,
    displayName: "Fee capability example detector",
    description:
      "Example third-party-style detector that reports fee-setter selectors. Local fixture only; never registered in production.",
    inputs: ["bytecode"],
    docs: "PLUGIN.md",
    outputSchema: OUTPUT_SCHEMA,
    capabilities: {},
    limits: { maxFindings: 8, maxEvidencePerFinding: 8, maxOutputBytes: 8192 },
  });
  if (!parsed.ok) {
    throw new Error(`example fee-capability manifest failed validation: ${parsed.error.kind}`);
  }
  if (parsed.value.kind !== "detector") {
    throw new Error(
      `example fee-capability manifest carries kind ${parsed.value.kind}, expected detector`,
    );
  }
  return parsed.value;
}

export const feeCapabilityManifest = manifestOf();
