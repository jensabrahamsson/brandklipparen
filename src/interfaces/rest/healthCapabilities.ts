// AI feature capability labels for GET /health (S-123). Pure: the same
// inputs always give the same capability frame, so the web UI can decide
// every AI unavailable state up front without inviting a click that
// dead-ends. Fields are additive; older readers keep using the
// top-level assessment field.
import type { AssessmentService } from "../../application/assessmentService.ts";
import type { ExplainService } from "../../application/explainService.ts";
import type { InvestigationService } from "../../application/investigationService.ts";
import type { PersonalizeService } from "../../application/personalizeService.ts";

export type HealthFeature = { readonly disabled: true } | { readonly provider: string; readonly modelId: string };

export type HealthOnchain = { readonly disabled: true } | { readonly available: true };

export type HealthCapabilities = {
  readonly assessment: HealthFeature;
  readonly investigation: HealthFeature;
  readonly explain: HealthFeature;
  readonly personalize: HealthFeature;
  readonly onchain: HealthOnchain;
};

export type HealthCapabilityInputs = {
  readonly assessmentService?: AssessmentService | undefined;
  readonly investigationService?: InvestigationService | undefined;
  readonly explainService?: ExplainService | undefined;
  readonly personalizeService?: PersonalizeService | undefined;
  readonly onchain?: unknown;
};

export function healthCapabilities(inputs: HealthCapabilityInputs): HealthCapabilities {
  const assessment = inputs.assessmentService;
  const explain = inputs.explainService;
  const investigation = inputs.investigationService;
  const personalize = inputs.personalizeService;
  return {
    assessment:
      assessment === undefined || assessment.provider === null || assessment.modelId === null
        ? { disabled: true }
        : { provider: assessment.provider, modelId: assessment.modelId },
    investigation:
      investigation === undefined || investigation.configured === false
        ? { disabled: true }
        : { provider: investigation.provider(), modelId: investigation.modelId() },
    explain:
      explain === undefined || !explain.enabled || explain.provider === null || explain.modelId === null
        ? { disabled: true }
        : { provider: explain.provider, modelId: explain.modelId },
    personalize:
      personalize === undefined
        ? { disabled: true }
        : { provider: personalize.provider, modelId: personalize.modelId },
    onchain: inputs.onchain === undefined ? { disabled: true } : { available: true },
  };
}
