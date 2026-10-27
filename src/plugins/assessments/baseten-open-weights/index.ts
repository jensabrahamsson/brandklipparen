// hosted open-weights assessment plugin
// `dev.brandklipparen.assessment.hosted-open-weights` (S-045, P-04,
// K-030). First-party assessment plugin behind the registry: the manifest
// wraps the existing hostedOpenWeightsAdapter implementation of
// AssessmentModelPort. The entry carries no code beyond the manifest; the
// composition root builds the single active adapter from the registered
// entry (A-34). The manifest declares no detector inputs: its sole input
// is the closed evidence list through the assessment path (K-302).
// Runtime boundary validation of provider output lives in
// validateAssessmentOutput (K-513); the outputSchema below publishes the
// labelled shape only. Pure manifest module: this module imports solely
// the plugin API and port types (P-03 boundary).
import { PLUGIN_API_VERSION, PluginManifest } from "../../api.ts";
import { createAssessmentPlugin } from "../../assessment.ts";
import type { AssessmentPlugin } from "../../assessment.ts";

// Output schema descriptor for the labelled assessment (ADR section
// 3.3): the draft-07 subset the registry documents. The descriptor
// publishes the provider-labelled shape; validation of provider output
// stays in validateAssessmentOutput at the adapter boundary.
const OUTPUT_SCHEMA = Object.freeze({
  type: "object",
  required: Object.freeze(["text", "provider", "modelId"]),
  properties: Object.freeze({
    text: Object.freeze({ type: "string", minLength: 1 }),
    provider: Object.freeze({ type: "string" }),
    modelId: Object.freeze({ type: "string" }),
  }),
  additionalProperties: false,
});

function manifestOf(): AssessmentPlugin["manifest"] {
  const parsed = PluginManifest.parse({
    id: "dev.brandklipparen.assessment.hosted-open-weights",
    version: "1.0.0",
    kind: "assessment",
    apiVersion: PLUGIN_API_VERSION,
    displayName: "hosted open-weights assessment",
    description: "Opt-in Muse contract assessment through hosted open weights.",
    inputs: [],
    outputSchema: OUTPUT_SCHEMA,
    capabilities: {
      needsNetwork: true,
      needsSecrets: false,
      affectsScore: false,
      runsInFastPath: false,
    },
    limits: {
      maxFindings: 1,
      maxEvidencePerFinding: 1,
      maxOutputBytes: 20000,
      deadlineMs: 30000,
      maxBytesIn: 1048576,
      maxBytesOut: 20000,
      maxConcurrency: 2,
    },
  });
  if (!parsed.ok) {
    throw new Error(
      `hosted-open-weights assessment manifest failed validation: ${parsed.error.kind}`,
    );
  }
  return parsed.value;
}

export const hostedOpenWeightsAssessmentPlugin: AssessmentPlugin = createAssessmentPlugin(
  manifestOf(),
  "hosted-open-weights",
);
