// AI feature capability labels for GET /health (S-123). Pure: the same
// inputs always give the same capability frame, so the web UI can decide
// every AI unavailable state up front without inviting a click that
// dead-ends. Fields are additive; older readers keep using the
// top-level assessment field.
import type { AssessmentService } from "../../application/assessmentService.ts";
import type { ChatService } from "../../application/chatService.ts";
import type { ExplainService } from "../../application/explainService.ts";
import type { InvestigationService } from "../../application/investigationService.ts";
import type { PersonalizeService } from "../../application/personalizeService.ts";
import type { RugService } from "../../application/rugService.ts";

export type HealthFeature = { readonly disabled: true } | { readonly provider: string; readonly modelId: string };

export type HealthOnchain = { readonly disabled: true } | { readonly available: true };

export type HealthMarket = { readonly disabled: true } | { readonly provider: string };

export type HealthCapabilities = {
  readonly assessment: HealthFeature;
  readonly investigation: HealthFeature;
  readonly explain: HealthFeature;
  readonly chat: HealthFeature;
  readonly rug: HealthFeature;
  readonly personalize: HealthFeature;
  readonly onchain: HealthOnchain;
  readonly market: HealthMarket;
};

export type HealthCapabilityInputs = {
  readonly assessmentService?: AssessmentService | undefined;
  readonly investigationService?: InvestigationService | undefined;
  readonly explainService?: ExplainService | undefined;
  readonly chatService?: ChatService | undefined;
  readonly rugService?: RugService | undefined;
  readonly personalizeService?: PersonalizeService | undefined;
  readonly onchain?: unknown;
  readonly market?: { readonly provider: string } | undefined;
};

function overlayFeature(service: { readonly enabled: boolean; readonly provider: string | null; readonly modelId: string | null } | undefined): HealthFeature {
  if (service === undefined || !service.enabled || service.provider === null || service.modelId === null) {
    return { disabled: true };
  }
  return { provider: service.provider, modelId: service.modelId };
}

export function healthCapabilities(inputs: HealthCapabilityInputs): HealthCapabilities {
  const assessment = inputs.assessmentService;
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
    explain: overlayFeature(inputs.explainService),
    chat: overlayFeature(inputs.chatService),
    rug: overlayFeature(inputs.rugService),
    personalize:
      personalize === undefined
        ? { disabled: true }
        : { provider: personalize.provider, modelId: personalize.modelId },
    onchain: inputs.onchain === undefined ? { disabled: true } : { available: true },
    market: inputs.market === undefined ? { disabled: true } : { provider: inputs.market.provider },
  };
}
