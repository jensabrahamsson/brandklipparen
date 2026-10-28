// Contract check for the hosted audit adapter over a recorded transport
// (S-054, K-516, K-513). No test reaches the network: each scenario
// replays a canned HTTP response. A missing key binds the not-configured
// adapter with zero sends.
import { describe, expect, test } from "vitest";
import { ModelId } from "../../src/domain/types.ts";
import { SecretString } from "../../src/ports/config.ts";
import {
  runPluginAuditModelPortContract,
} from "./pluginAuditModel.contract.ts";
import type { PluginAuditContractScenario } from "./pluginAuditModel.contract.ts";
import {
  hostedAuditAdapter,
  createhostedAuditAdapterFromConfig,
} from "../../src/adapters/audit/hostedAuditAdapter.ts";
import type { hostedAuditTransport } from "../../src/adapters/audit/hostedAuditAdapter.ts";

const MODEL_ID = "meta-models/muse-spark-open-1026";

function mustModelId(): ModelId {
  const parsed = ModelId.parse(MODEL_ID);
  if (!parsed.ok) {
    throw new Error(`test model id is invalid: ${parsed.error.message}`);
  }
  return parsed.value;
}

function cleanBody(): string {
  return JSON.stringify({
    provider: "hosted-open-weights",
    modelId: MODEL_ID,
    pluginId: "dev.brandklipparen.capability",
    pluginVersion: "1.0.0",
    promptVersion: "1.0.0",
    findings: [],
  });
}

function findingsBody(): string {
  return JSON.stringify({
    provider: "hosted-open-weights",
    modelId: MODEL_ID,
    pluginId: "dev.brandklipparen.capability",
    pluginVersion: "1.0.0",
    promptVersion: "1.0.0",
    findings: [
      {
        severity: "low",
        location: "index.ts:1",
        category: "determinism",
        rationale: "Recorded rationale for tests only.",
        confidence: 0.5,
        quotedEvidence: "Quoted excerpt for tests only.",
      },
    ],
  });
}

function recordedTransport(scenario: PluginAuditContractScenario): hostedAuditTransport {
  return async () => {
    switch (scenario) {
      case "clean":
        return { status: 200, bodyText: cleanBody() };
      case "findings":
        return { status: 200, bodyText: findingsBody() };
      case "timeout":
        return new Promise<never>(() => {});
      case "rate-limited":
        return { status: 429, bodyText: "limited" };
      case "invalid-output":
        return { status: 200, bodyText: "not json {" };
      case "output-too-large":
        return { status: 200, bodyText: "x".repeat(200000) };
      case "unavailable":
        return { status: 503, bodyText: "down" };
      case "provider-mismatch":
        return {
          status: 200,
          bodyText: JSON.stringify({
            provider: "meta-model-api",
            modelId: MODEL_ID,
            pluginId: "dev.brandklipparen.capability",
            pluginVersion: "1.0.0",
            promptVersion: "1.0.0",
            findings: [],
          }),
        };
    }
  };
}

describe("hosted audit adapter", () => {
  runPluginAuditModelPortContract("hosted-recorded", (scenario: PluginAuditContractScenario) => {
    return new hostedAuditAdapter({
      endpoint: "https://api.example.test/audit",
      apiKey: new SecretString("test-key"),
      modelId: mustModelId(),
      timeoutMs: scenario === "timeout" ? 5 : 1000,
      transport: recordedTransport(scenario),
    });
  });

  test("k516_audit_without_key_reports_not_configured_and_sends_nothing", async () => {
    let sends = 0;
    const counting: hostedAuditTransport = async () => {
      sends += 1;
      return { status: 200, bodyText: "{}" };
    };
    const built = createhostedAuditAdapterFromConfig(
      {
        audithostedBaseUrl: undefined,
        audithostedApiKey: undefined,
        audithostedModelId: undefined,
      },
      counting,
    );
    expect(built.ok).toBe(true);
    if (!built.ok) {
      return;
    }
    const { PluginAuditInput } = await import("../../src/ports/pluginAuditModel.ts");
    const { PromptVersion, RequestId, Timestamp } = await import("../../src/domain/types.ts");
    const mustOk = <T>(result: { ok: true; value: T } | { ok: false; error: { message: string } }): T => {
      if (!result.ok) {
        throw new Error(`expected ok: ${result.error.message}`);
      }
      return result.value;
    };
    const input = mustOk(
      PluginAuditInput.create({
        pluginId: "dev.brandklipparen.capability",
        pluginVersion: "1.0.0",
        files: [{ path: "index.ts", sha256: "abc", quotedContent: "source" }],
        promptVersion: mustOk(PromptVersion.parse("1.0.0")),
      }),
    );
    const result = await built.value.review(input, {
      requestId: mustOk(RequestId.parse("123e4567-e89b-12d3-a456-426614174000")),
      deadline: mustOk(Timestamp.of(1761446400000)),
      block: "latest",
    });
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.error.kind).toBe("not-configured");
    expect(sends).toBe(0);
  });
});
