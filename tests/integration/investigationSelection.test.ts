// Investigation service selection in the composition root (S-075, K-036,
// P-29). Without the hosted triple the service answers `not-configured`
// with zero provider calls; with the full triple set the service binds
// the configured adapter with model id labelling. Startup never fails on
// a missing investigate triple. All transports are in-memory fakes; no
// network happens here.
import { describe, expect, test } from "vitest";
import { parseModelArtifact } from "../../src/domain/risk.ts";
import type { Result } from "../../src/domain/result.ts";
import {
  Address,
  ArtifactChecksum,
  BlockNumber,
  IndexVersion,
  ModelVersion,
  RequestId,
  TemplateVersion,
  Timestamp,
} from "../../src/domain/types.ts";
import type { CapabilityCatalogue } from "../../src/domain/signals.ts";
import { createAppServices } from "../../src/application/analyzeToken.ts";
import type { AssessmentEnvelope } from "../../src/application/analyzeToken.ts";
import {
  buildDetectorSet,
  createInvestigationServiceFromConfig,
} from "../../src/composition/root.ts";
import { loadConfig } from "../../src/adapters/config/loader.ts";
import { formatConfigError } from "../../src/ports/config.ts";
import type { ConfigError } from "../../src/ports/config.ts";
import type {
  hostedInvestigateTransport,
  hostedInvestigateTransportResponse,
} from "../../src/adapters/investigation/hostedInvestigateAdapter.ts";
import { FakeClockAdapter } from "../fakes/fakeClock.ts";
import { FakeModelArtifactAdapter } from "../fakes/fakeModelArtifact.ts";
import { FakeRpcAdapter } from "../fakes/fakeRpc.ts";
import { mustDefaultDetectorSet } from "../helpers/detectorSets.ts";

function mustOk<T>(result: Result<T, { message: string }>): T {
  if (!result.ok) {
    throw new Error(`expected ok, got error: ${result.error.message}`);
  }
  return result.value;
}

function mustConfig<T>(result: Result<T, ConfigError>): T {
  if (!result.ok) {
    throw new Error(`expected config ok, got error: ${formatConfigError(result.error)}`);
  }
  return result.value;
}

function mustDetectors<T>(result: Result<T, { kind: string }>): T {
  if (!result.ok) {
    throw new Error(`expected detector set ok, got error: ${result.error.kind}`);
  }
  return result.value;
}

function baseCiEnv(): Record<string, string | undefined> {
  return {
    BRANDKLIPPAREN_ENV: "ci",
    BRANDKLIPPAREN_MODEL_VERSION: "0.1.0",
    BRANDKLIPPAREN_MODEL_ARTIFACT_PATH: "model/artifact-0.1.0.json",
    BRANDKLIPPAREN_CLONE_INDEX_VERSION: "1.0.0",
    BRANDKLIPPAREN_LOG_LEVEL: "info",
  };
}

const TEST_ADDRESS = "0x0102030405060708090a0b0c0d0e0f1011121314";
const TEST_BYTECODE = `0x8063a9059cbb14600a57${"00".repeat(10)}ff`;

const TEST_CATALOGUE: CapabilityCatalogue = Object.freeze({
  selfdestruct: Object.freeze({ risk: "rug-pull", direction: "raises", severity: "high" }),
  delegatecall: Object.freeze({ risk: "rug-pull", direction: "raises", severity: "high" }),
  call: Object.freeze({ risk: "honeypot", direction: "raises", severity: "medium" }),
  "storage-write": Object.freeze({ risk: "bot-pump", direction: "raises", severity: "low" }),
});

function placeholderArtifact(): FakeModelArtifactAdapter {
  const artifact = mustOk(
    parseModelArtifact({
      version: "0.1.0",
      severityWeights: { low: 0.2, medium: 0.5, high: 1.0 },
      causeWeights: {
        timeout: 0.4,
        "resource-limit": 0.4,
        "decompiler-error": 0.6,
        "obfuscated-structure": 0.6,
      },
      biases: { "rug-pull": 0.0, honeypot: 0.0, "bot-pump": 0.0 },
      calibration: {
        "rug-pull": { slope: 1.0, intercept: 0.0 },
        honeypot: { slope: 1.0, intercept: 0.0 },
        "bot-pump": { slope: 1.0, intercept: 0.0 },
      },
      scoreWeights: { "rug-pull": 1.0, honeypot: 1.0, "bot-pump": 1.0 },
    }),
  );
  return new FakeModelArtifactAdapter(
    Object.freeze({
      artifact,
      checksum: mustOk(ArtifactChecksum.parse("ab".repeat(32))),
    }),
  );
}

async function assessedEnvelope(): Promise<AssessmentEnvelope> {
  const codes = new Map<string, string>([[mustOk(Address.parse(TEST_ADDRESS)) as string, TEST_BYTECODE]]);
  const services = createAppServices(
    {
      rpc: new FakeRpcAdapter(codes, mustOk(BlockNumber.of(18000000))),
      modelArtifacts: placeholderArtifact(),
      clock: new FakeClockAdapter(mustOk(Timestamp.of(1700000000000))),
    },
    mustDefaultDetectorSet(),
  );
  const analysed = await services.analyzeToken({
    address: mustOk(Address.parse(TEST_ADDRESS)),
    block: "latest",
    requestId: mustOk(RequestId.parse("123e4567-e89b-12d3-a456-426614174000")),
    deadline: mustOk(Timestamp.of(1700000000000 + 30000)),
    modelVersion: mustOk(ModelVersion.parse("0.1.0")),
    indexVersion: mustOk(IndexVersion.parse("1.0.0")),
    templateVersion: mustOk(TemplateVersion.parse("1.0.0")),
    catalogue: TEST_CATALOGUE,
  });
  if (!analysed.ok || analysed.value.kind !== "assessed") {
    throw new Error("expected an assessed envelope from the fake analysis");
  }
  return analysed.value.envelope;
}

function envelopeFor(inner: unknown, model: string): string {
  return JSON.stringify({
    id: "chatcmpl-recorded-1",
    object: "chat.completion",
    created: 1700000000,
    model,
    choices: [{ index: 0, message: { role: "assistant", content: JSON.stringify(inner) }, finish_reason: "stop" }],
    usage: { prompt_tokens: 200, completion_tokens: 60, total_tokens: 260 },
  });
}

describe("investigation service selection", () => {
  test("k520_investigation_service_without_key_reports_not_configured", async () => {
    const config = mustConfig(loadConfig(baseCiEnv()));
    const service = mustConfig(createInvestigationServiceFromConfig(config, mustDetectors(buildDetectorSet())));
    expect(service.provider()).toBe("hosted-open-weights");
    expect(service.modelId()).toBe("meta-models/muse-spark-open-1026");
    const envelope = await assessedEnvelope();
    const result = await service.investigateEnvelope(
      envelope,
      {
        requestId: mustOk(RequestId.parse("123e4567-e89b-12d3-a456-426614174001")),
        deadline: mustOk(Timestamp.of(1700000000000 + 30000)),
        block: "latest",
      },
      { now: () => 1700000000000 },
    );
    expect(result.status).toBe("not-configured");
  });

  test("k520_investigation_service_with_key_binds_configured_adapter", async () => {
    let sends = 0;
    const transport: hostedInvestigateTransport = async (): Promise<hostedInvestigateTransportResponse> => {
      sends += 1;
      return {
        status: 200,
        bodyText: envelopeFor(
          {
            provider: "hosted-open-weights",
            modelId: "meta-models/muse-spark-open-1026",
            decision: {
              kind: "conclude",
              narrativeDraft: "Recorded conclusion without citations.",
              rationale: "Recorded rationale: conclude from the frozen evidence.",
            },
          },
          "meta-models/muse-spark-open-1026",
        ),
      };
    };
    const config = mustConfig(
      loadConfig({
        ...baseCiEnv(),
        BRANDKLIPPAREN_INVESTIGATE_hosted_BASE_URL: "https://api.example.invalid/v1/chat",
        BRANDKLIPPAREN_INVESTIGATE_hosted_API_KEY: "fake-key-for-tests-only",
        BRANDKLIPPAREN_INVESTIGATE_hosted_MODEL_ID: "meta-models/muse-spark-open-1026",
        BRANDKLIPPAREN_INVESTIGATE_DEADLINE_MS: "30000",
        BRANDKLIPPAREN_INVESTIGATE_MAX_STEPS: "8",
      }),
    );
    const service = mustConfig(
      createInvestigationServiceFromConfig(config, mustDetectors(buildDetectorSet()), { transport }),
    );
    expect(service.provider()).toBe("hosted-open-weights");
    expect(service.modelId()).toBe("meta-models/muse-spark-open-1026");
    const envelope = await assessedEnvelope();
    const result = await service.investigateEnvelope(
      envelope,
      {
        requestId: mustOk(RequestId.parse("123e4567-e89b-12d3-a456-426614174002")),
        deadline: mustOk(Timestamp.of(1700000000000 + 30000)),
        block: "latest",
      },
      { now: () => 1700000000000 },
    );
    expect(sends).toBeGreaterThan(0);
    expect(result.status).toBe("done");
  });

  test("k520_investigate_limits_reject_non_positive_steps", () => {
    const config = loadConfig({ ...baseCiEnv(), BRANDKLIPPAREN_INVESTIGATE_MAX_STEPS: "0" });
    expect(config.ok).toBe(false);
  });

  test("investigation_shares_the_vendor_neutral_assessment_triple", async () => {
    let sends = 0;
    let seenUrl = "";
    const transport: hostedInvestigateTransport = async (
      url,
    ): Promise<hostedInvestigateTransportResponse> => {
      sends += 1;
      seenUrl = url;
      return {
        status: 200,
        bodyText: envelopeFor(
          {
            provider: "generic-compatible",
            modelId: "fake-compat-model-1",
            decision: {
              kind: "conclude",
              narrativeDraft: "Recorded conclusion without citations.",
              rationale: "Recorded rationale: conclude from the frozen evidence.",
            },
          },
          "fake-compat-model-1",
        ),
      };
    };
    const config = mustConfig(
      loadConfig({
        ...baseCiEnv(),
        BRANDKLIPPAREN_ASSESSMENT_PROVIDER: "generic-compatible",
        BRANDKLIPPAREN_ASSESSMENT_generic_COMPATIBLE_BASE_URL: "https://compat.example.invalid/v1/chat",
        BRANDKLIPPAREN_ASSESSMENT_generic_COMPATIBLE_API_KEY: "fake-key-for-tests-only",
        BRANDKLIPPAREN_ASSESSMENT_generic_COMPATIBLE_MODEL_ID: "fake-compat-model-1",
      }),
    );
    const service = mustConfig(
      createInvestigationServiceFromConfig(config, mustDetectors(buildDetectorSet()), { transport }),
    );
    expect(service.provider()).toBe("generic-compatible");
    expect(service.modelId()).toBe("fake-compat-model-1");
    const envelope = await assessedEnvelope();
    const result = await service.investigateEnvelope(
      envelope,
      {
        requestId: mustOk(RequestId.parse("123e4567-e89b-12d3-a456-426614174003")),
        deadline: mustOk(Timestamp.of(1700000000000 + 30000)),
        block: "latest",
      },
      { now: () => 1700000000000 },
    );
    expect(sends).toBeGreaterThan(0);
    expect(seenUrl).toBe("https://compat.example.invalid/v1/chat/chat/completions");
    expect(result.status).toBe("done");
  });

  test("investigate_provider_meta_binds_configured_adapter", async () => {
    let sends = 0;
    const transport: hostedInvestigateTransport = async (): Promise<hostedInvestigateTransportResponse> => {
      sends += 1;
      return {
        status: 200,
        bodyText: envelopeFor(
          {
            provider: "meta-model-api",
            modelId: "muse-spark-1.3",
            decision: {
              kind: "conclude",
              narrativeDraft: "Recorded conclusion without citations.",
              rationale: "Recorded rationale: conclude from the frozen evidence.",
            },
          },
          "muse-spark-1.3",
        ),
      };
    };
    const config = mustConfig(
      loadConfig({
        ...baseCiEnv(),
        BRANDKLIPPAREN_INVESTIGATE_PROVIDER: "meta-model-api",
        BRANDKLIPPAREN_INVESTIGATE_META_BASE_URL: "https://meta.example.invalid/v1",
        BRANDKLIPPAREN_INVESTIGATE_META_API_KEY: "fake-key-for-tests-only",
        BRANDKLIPPAREN_INVESTIGATE_META_MODEL_ID: "muse-spark-1.3",
      }),
    );
    const service = mustConfig(
      createInvestigationServiceFromConfig(config, mustDetectors(buildDetectorSet()), { transport }),
    );
    expect(service.provider()).toBe("meta-model-api");
    expect(service.modelId()).toBe("muse-spark-1.3");
    expect(service.configured).toBe(true);
    const envelope = await assessedEnvelope();
    const result = await service.investigateEnvelope(
      envelope,
      {
        requestId: mustOk(RequestId.parse("123e4567-e89b-12d3-a456-426614174010")),
        deadline: mustOk(Timestamp.of(1700000000000 + 30000)),
        block: "latest",
      },
      { now: () => 1700000000000 },
    );
    expect(sends).toBeGreaterThan(0);
    expect(result.status).toBe("done");
  });

  test("investigate_provider_meta_without_model_defaults_to_muse_spark", async () => {
    const transport: hostedInvestigateTransport = async (): Promise<hostedInvestigateTransportResponse> => ({
      status: 200,
      bodyText: envelopeFor(
        {
          provider: "meta-model-api",
          modelId: "muse-spark-1.3",
          decision: {
            kind: "conclude",
            narrativeDraft: "Recorded conclusion without citations.",
            rationale: "Recorded rationale: conclude from the frozen evidence.",
          },
        },
        "muse-spark-1.3",
      ),
    });
    const config = mustConfig(
      loadConfig({
        ...baseCiEnv(),
        BRANDKLIPPAREN_INVESTIGATE_PROVIDER: "meta-model-api",
        BRANDKLIPPAREN_INVESTIGATE_META_BASE_URL: "https://meta.example.invalid/v1",
        BRANDKLIPPAREN_INVESTIGATE_META_API_KEY: "fake-key-for-tests-only",
      }),
    );
    const service = mustConfig(
      createInvestigationServiceFromConfig(config, mustDetectors(buildDetectorSet()), { transport }),
    );
    expect(service.provider()).toBe("meta-model-api");
    expect(service.modelId()).toBe("muse-spark-1.3");
    expect(service.configured).toBe(true);
  });

  test("investigate_provider_meta_without_triple_stays_not_configured", async () => {
    let sends = 0;
    const transport: hostedInvestigateTransport = async (): Promise<hostedInvestigateTransportResponse> => {
      sends += 1;
      return { status: 200, bodyText: "{}" };
    };
    const config = mustConfig(
      loadConfig({ ...baseCiEnv(), BRANDKLIPPAREN_INVESTIGATE_PROVIDER: "meta-model-api" }),
    );
    const service = mustConfig(
      createInvestigationServiceFromConfig(config, mustDetectors(buildDetectorSet()), { transport }),
    );
    expect(service.provider()).toBe("meta-model-api");
    expect(service.modelId()).toBe("muse-spark-1.3");
    expect(service.configured).toBe(false);
    const envelope = await assessedEnvelope();
    const result = await service.investigateEnvelope(
      envelope,
      {
        requestId: mustOk(RequestId.parse("123e4567-e89b-12d3-a456-426614174011")),
        deadline: mustOk(Timestamp.of(1700000000000 + 30000)),
        block: "latest",
      },
      { now: () => 1700000000000 },
    );
    expect(sends).toBe(0);
    expect(result.status).toBe("not-configured");
  });

  test("investigate_provider_off_disables_the_loop_with_zero_sends", async () => {
    let sends = 0;
    const transport: hostedInvestigateTransport = async (): Promise<hostedInvestigateTransportResponse> => {
      sends += 1;
      return { status: 200, bodyText: "{}" };
    };
    const config = mustConfig(
      loadConfig({
        ...baseCiEnv(),
        BRANDKLIPPAREN_INVESTIGATE_PROVIDER: "off",
        BRANDKLIPPAREN_INVESTIGATE_META_BASE_URL: "https://meta.example.invalid/v1",
        BRANDKLIPPAREN_INVESTIGATE_META_API_KEY: "fake-key-for-tests-only",
        BRANDKLIPPAREN_INVESTIGATE_META_MODEL_ID: "muse-spark-1.3",
      }),
    );
    const service = mustConfig(
      createInvestigationServiceFromConfig(config, mustDetectors(buildDetectorSet()), { transport }),
    );
    expect(service.configured).toBe(false);
    const envelope = await assessedEnvelope();
    const result = await service.investigateEnvelope(
      envelope,
      {
        requestId: mustOk(RequestId.parse("123e4567-e89b-12d3-a456-426614174012")),
        deadline: mustOk(Timestamp.of(1700000000000 + 30000)),
        block: "latest",
      },
      { now: () => 1700000000000 },
    );
    expect(sends).toBe(0);
    expect(result.status).toBe("not-configured");
  });

  test("investigate_provider_explicit_meta_wins_over_shared_assessment_config", async () => {
    const transport: hostedInvestigateTransport = async (): Promise<hostedInvestigateTransportResponse> => ({
      status: 200,
      bodyText: envelopeFor(
        {
          provider: "meta-model-api",
          modelId: "muse-spark-1.3",
          decision: {
            kind: "conclude",
            narrativeDraft: "Recorded conclusion without citations.",
            rationale: "Recorded rationale: conclude from the frozen evidence.",
          },
        },
        "muse-spark-1.3",
      ),
    });
    const config = mustConfig(
      loadConfig({
        ...baseCiEnv(),
        BRANDKLIPPAREN_ASSESSMENT_PROVIDER: "generic-compatible",
        BRANDKLIPPAREN_ASSESSMENT_generic_COMPATIBLE_BASE_URL: "https://compat.example.invalid/v1/chat",
        BRANDKLIPPAREN_ASSESSMENT_generic_COMPATIBLE_API_KEY: "fake-key-for-tests-only",
        BRANDKLIPPAREN_ASSESSMENT_generic_COMPATIBLE_MODEL_ID: "fake-compat-model-1",
        BRANDKLIPPAREN_INVESTIGATE_PROVIDER: "meta-model-api",
        BRANDKLIPPAREN_INVESTIGATE_META_BASE_URL: "https://meta.example.invalid/v1",
        BRANDKLIPPAREN_INVESTIGATE_META_API_KEY: "fake-key-for-tests-only",
      }),
    );
    const service = mustConfig(
      createInvestigationServiceFromConfig(config, mustDetectors(buildDetectorSet()), { transport }),
    );
    expect(service.provider()).toBe("meta-model-api");
    expect(service.modelId()).toBe("muse-spark-1.3");
    expect(service.configured).toBe(true);
  });

  test("investigate_provider_invalid_value_fails_startup", () => {
    const loaded = loadConfig({ ...baseCiEnv(), BRANDKLIPPAREN_INVESTIGATE_PROVIDER: "bogus-provider" });
    expect(loaded.ok).toBe(false);
    if (!loaded.ok) {
      expect(loaded.error.variable).toBe("BRANDKLIPPAREN_INVESTIGATE_PROVIDER");
    }
  });

  test("explicit_investigation_triple_wins_over_shared_assessment_config", async () => {
    const transport: hostedInvestigateTransport = async (): Promise<hostedInvestigateTransportResponse> => ({
      status: 200,
      bodyText: envelopeFor(
        {
          provider: "hosted-open-weights",
          modelId: "meta-models/muse-spark-open-1026",
          decision: {
            kind: "conclude",
            narrativeDraft: "Recorded conclusion without citations.",
            rationale: "Recorded rationale: conclude from the frozen evidence.",
          },
        },
        "meta-models/muse-spark-open-1026",
      ),
    });
    const config = mustConfig(
      loadConfig({
        ...baseCiEnv(),
        BRANDKLIPPAREN_ASSESSMENT_PROVIDER: "generic-compatible",
        BRANDKLIPPAREN_ASSESSMENT_generic_COMPATIBLE_BASE_URL: "https://compat.example.invalid/v1/chat",
        BRANDKLIPPAREN_ASSESSMENT_generic_COMPATIBLE_API_KEY: "fake-key-for-tests-only",
        BRANDKLIPPAREN_ASSESSMENT_generic_COMPATIBLE_MODEL_ID: "fake-compat-model-1",
        BRANDKLIPPAREN_INVESTIGATE_hosted_BASE_URL: "https://api.example.invalid/v1/chat",
        BRANDKLIPPAREN_INVESTIGATE_hosted_API_KEY: "fake-key-for-tests-only",
        BRANDKLIPPAREN_INVESTIGATE_hosted_MODEL_ID: "meta-models/muse-spark-open-1026",
      }),
    );
    const service = mustConfig(
      createInvestigationServiceFromConfig(config, mustDetectors(buildDetectorSet()), { transport }),
    );
    expect(service.provider()).toBe("hosted-open-weights");
    expect(service.modelId()).toBe("meta-models/muse-spark-open-1026");
    const envelope = await assessedEnvelope();
    const result = await service.investigateEnvelope(
      envelope,
      {
        requestId: mustOk(RequestId.parse("123e4567-e89b-12d3-a456-426614174004")),
        deadline: mustOk(Timestamp.of(1700000000000 + 30000)),
        block: "latest",
      },
      { now: () => 1700000000000 },
    );
    expect(result.status).toBe("done");
  });
});
