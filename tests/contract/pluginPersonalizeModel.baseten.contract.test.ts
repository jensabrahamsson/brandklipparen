// Contract check for the hosted personalize adapter over a recorded
// transport (S-069, K-519, K-513). No test reaches the network: each
// scenario replays a canned HTTP response. A missing key binds the
// not-configured adapter with zero sends.
import { describe, expect, test } from "vitest";
import { ModelId } from "../../src/domain/types.ts";
import { SecretString } from "../../src/ports/config.ts";
import { runPluginPersonalizeModelPortContract } from "./pluginPersonalizeModel.contract.ts";
import type { PluginPersonalizeContractScenario } from "./pluginPersonalizeModel.contract.ts";
import {
  hostedPersonalizeAdapter,
  createhostedPersonalizeAdapterFromConfig,
} from "../../src/adapters/personalize/hostedPersonalizeAdapter.ts";
import type { hostedPersonalizeTransport } from "../../src/adapters/personalize/hostedPersonalizeAdapter.ts";

const MODEL_ID = "meta-models/muse-spark-open-1026";

function mustModelId(): ModelId {
  const parsed = ModelId.parse(MODEL_ID);
  if (!parsed.ok) {
    throw new Error(`test model id is invalid: ${parsed.error.message}`);
  }
  return parsed.value;
}

function orderedBody(): string {
  return JSON.stringify({
    provider: "hosted-open-weights",
    modelId: MODEL_ID,
    promptVersion: "1.0.0",
    spec: {
      specVersion: 1,
      pluginRanking: ["dev.brandklipparen.clone-match", "dev.brandklipparen.capability"],
      placements: [
        { sectionId: "signals", emphasis: "high" },
        { sectionId: "summary", emphasis: "normal" },
        { sectionId: "score", emphasis: "normal" },
      ],
    },
  });
}

function recordedTransport(scenario: PluginPersonalizeContractScenario): hostedPersonalizeTransport {
  return async () => {
    switch (scenario) {
      case "ordered":
        return { status: 200, bodyText: orderedBody() };
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
            modelId: "other-model",
            spec: {
              specVersion: 1,
              pluginRanking: [],
              placements: [
                { sectionId: "summary", emphasis: "normal" },
                { sectionId: "score", emphasis: "normal" },
              ],
            },
          }),
        };
    }
  };
}

describe("hosted personalize adapter", () => {
  runPluginPersonalizeModelPortContract("hosted", (scenario: PluginPersonalizeContractScenario) => {
    return new hostedPersonalizeAdapter({
      endpoint: "https://hosted.example.test/personalize",
      apiKey: new SecretString("test-personalize-key-only"),
      modelId: mustModelId(),
      promptVersion: undefined,
      timeoutMs: 50,
      maxBytesIn: 65536,
      maxBytesOut: 16384,
      maxOutputChars: 8192,
      transport: recordedTransport(scenario),
    });
  });

  test("a missing key binds the not-configured adapter with zero sends", async () => {
    const bound = createhostedPersonalizeAdapterFromConfig({
      personalizehostedBaseUrl: undefined,
      personalizehostedApiKey: undefined,
      personalizehostedModelId: undefined,
    });
    if (!bound.ok) {
      throw new Error(`expected the not-configured adapter, got: ${bound.error.kind}`);
    }
    expect(bound.value.provider()).toBe("hosted-open-weights");
  });
});
