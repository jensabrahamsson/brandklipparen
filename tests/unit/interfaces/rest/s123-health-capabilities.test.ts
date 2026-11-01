// Health capability labels (S-123): every optional AI feature reports
// configured or disabled, so the web UI decides unavailable states up
// front. No real services or network here; minimal structural stubs only.
import { describe, expect, test } from "vitest";
import { healthCapabilities } from "../../../../src/interfaces/rest/healthCapabilities.ts";
import type { AssessmentService } from "../../../../src/application/assessmentService.ts";
import type { ChatService } from "../../../../src/application/chatService.ts";
import type { ExplainService } from "../../../../src/application/explainService.ts";
import type { InvestigationService } from "../../../../src/application/investigationService.ts";
import type { PersonalizeService } from "../../../../src/application/personalizeService.ts";
import type { RugService } from "../../../../src/application/rugService.ts";

function assessment(provider: string | null, modelId: string | null): AssessmentService {
  return { provider, modelId } as unknown as AssessmentService;
}

function investigation(): InvestigationService {
  return { provider: () => "hosted-open-weights", modelId: () => "meta-models/muse-spark-open-1026" } as unknown as InvestigationService;
}

function unconfiguredInvestigation(): InvestigationService {
  return {
    provider: () => "meta-model-api",
    modelId: () => "muse-spark-1.3",
    configured: false,
  } as unknown as InvestigationService;
}

function explain(enabled: boolean): ExplainService {
  return {
    enabled,
    provider: "hosted-open-weights",
    modelId: "meta-models/muse-spark-open-1026",
  } as unknown as ExplainService;
}

function chat(enabled: boolean): ChatService {
  return {
    enabled,
    provider: "meta-model-api",
    modelId: "muse-spark-1.3",
  } as unknown as ChatService;
}

function rug(enabled: boolean): RugService {
  return {
    enabled,
    provider: "meta-model-api",
    modelId: "muse-spark-1.3",
  } as unknown as RugService;
}

function personalize(): PersonalizeService {
  return {
    provider: "hosted-open-weights",
    modelId: "meta-models/muse-spark-open-1026",
  } as unknown as PersonalizeService;
}

describe("health capabilities", () => {
  test("s123_absent_services_report_disabled", () => {
    expect(healthCapabilities({})).toEqual({
      assessment: { disabled: true },
      investigation: { disabled: true },
      explain: { disabled: true },
      chat: { disabled: true },
      rug: { disabled: true },
      personalize: { disabled: true },
      onchain: { disabled: true },
      market: { disabled: true },
      source: { disabled: true },
    });
  });

  test("s123_configured_services_report_provider_and_model", () => {
    expect(
      healthCapabilities({
        assessmentService: assessment("hosted-open-weights", "assessment-model-1"),
        investigationService: investigation(),
        explainService: explain(true),
        chatService: chat(true),
        rugService: rug(true),
        personalizeService: personalize(),
        onchain: { rpc: {}, weth: null },
      }),
    ).toEqual({
      assessment: { provider: "hosted-open-weights", modelId: "assessment-model-1" },
      investigation: { provider: "hosted-open-weights", modelId: "meta-models/muse-spark-open-1026" },
      explain: { provider: "hosted-open-weights", modelId: "meta-models/muse-spark-open-1026" },
      chat: { provider: "meta-model-api", modelId: "muse-spark-1.3" },
      rug: { provider: "meta-model-api", modelId: "muse-spark-1.3" },
      personalize: { provider: "hosted-open-weights", modelId: "meta-models/muse-spark-open-1026" },
      onchain: { available: true },
      market: { disabled: true },
      source: { disabled: true },
    });
  });

  test("s123_unconfigured_investigation_reports_disabled_with_meta_labelling", () => {
    expect(
      healthCapabilities({
        assessmentService: assessment("meta-model-api", "muse-spark-1.3"),
        investigationService: unconfiguredInvestigation(),
        onchain: { rpc: {}, weth: null },
      }),
    ).toEqual({
      assessment: { provider: "meta-model-api", modelId: "muse-spark-1.3" },
      investigation: { disabled: true },
      explain: { disabled: true },
      chat: { disabled: true },
      rug: { disabled: true },
      personalize: { disabled: true },
      onchain: { available: true },
      market: { disabled: true },
      source: { disabled: true },
    });
  });

  test("s123_partial_configuration_disables_only_the_missing_feature", () => {
    expect(
      healthCapabilities({
        assessmentService: assessment(null, null),
        investigationService: investigation(),
        explainService: explain(false),
        chatService: chat(false),
      }),
    ).toEqual({
      assessment: { disabled: true },
      investigation: { provider: "hosted-open-weights", modelId: "meta-models/muse-spark-open-1026" },
      explain: { disabled: true },
      chat: { disabled: true },
      rug: { disabled: true },
      personalize: { disabled: true },
      onchain: { disabled: true },
      market: { disabled: true },
      source: { disabled: true },
    });
  });

  test("dxb1_market_listing_reports_provider_when_bound", () => {
    expect(healthCapabilities({ market: { provider: "dexscreener" } })).toMatchObject({
      market: { provider: "dexscreener" },
    });
    expect(healthCapabilities({})).toMatchObject({ market: { disabled: true } });
  });

  test("vsb2_source_reports_provider_when_bound", () => {
    expect(healthCapabilities({ source: { provider: "sourcify" } })).toMatchObject({
      source: { provider: "sourcify" },
    });
    expect(healthCapabilities({})).toMatchObject({ source: { disabled: true } });
  });
});
