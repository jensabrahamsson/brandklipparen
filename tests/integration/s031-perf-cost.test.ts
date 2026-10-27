// S-031 performance, observability and cost frames (K-101, K-104, K-107).
// Written first per A-21 (red): the observability frame, the p95 helper,
// the request counters and the REST cost metadata do not exist yet, so the
// named tests below fail until the frame lands. All ports are in-memory
// fakes over recorded-style fixtures: no live calls, no real keys, no paid
// consumption. Detection thresholds stay in the versioned artifact; the
// values below are placeholders for tests only (K-210).
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { parseModelArtifact } from "../../src/domain/risk.ts";
import type { ModelArtifact } from "../../src/domain/risk.ts";
import type { Result } from "../../src/domain/result.ts";
import {
  Address,
  ArtifactChecksum,
  BlockNumber,
  IndexVersion,
  ModelVersion,
  PromptVersion,
  RequestId,
  TemplateVersion,
  Timestamp,
} from "../../src/domain/types.ts";
import type { CapabilityCatalogue } from "../../src/domain/signals.ts";
import { createAppServices } from "../../src/application/analyzeToken.ts";
import type { AppServices } from "../../src/application/analyzeToken.ts";
import {
  createAssessmentService,
  createInMemoryAssessmentCostMeter,
} from "../../src/application/assessmentService.ts";
import {
  createRequestCounters,
  p95Ms,
} from "../../src/application/observability.ts";
import { SecretString } from "../../src/ports/config.ts";
import { FakeAssessmentModelAdapter } from "../fakes/fakeAssessmentModel.ts";
import { FakeClockAdapter } from "../fakes/fakeClock.ts";
import { FakeModelArtifactAdapter } from "../fakes/fakeModelArtifact.ts";
import { FakeRpcAdapter } from "../fakes/fakeRpc.ts";
import { createRestServer } from "../../src/interfaces/rest/server.ts";
import type { RestServer } from "../../src/interfaces/rest/server.ts";
import { mustDefaultDetectorSet } from "../helpers/detectorSets.ts";

function mustOk<T, E extends { message: string }>(result: Result<T, E>): T {
  if (!result.ok) {
    throw new Error(`expected ok, got error: ${result.error.message}`);
  }
  return result.value;
}

// Placeholder calibration for tests only (K-210): finite test weights with
// no learned values, so scoring runs deterministically.
function placeholderArtifact(): FakeModelArtifactAdapter {
  const artifact: ModelArtifact = mustOk(
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
      checksum: mustOk(ArtifactChecksum.parse("cd".repeat(32))),
    }),
  );
}

// Placeholder catalogue for tests only: fixed risk mapping per capability
// key, so detection yields signals without carrying learned values.
const TEST_CATALOGUE: CapabilityCatalogue = Object.freeze({
  selfdestruct: Object.freeze({ risk: "rug-pull", direction: "raises", severity: "high" }),
  delegatecall: Object.freeze({ risk: "rug-pull", direction: "raises", severity: "high" }),
  call: Object.freeze({ risk: "honeypot", direction: "raises", severity: "medium" }),
  "storage-write": Object.freeze({ risk: "bot-pump", direction: "raises", severity: "low" }),
});

const TEST_ADDRESS = "0x0102030405060708090a0b0c0d0e0f1011121314";
const TEST_BYTECODE = `0x8063a9059cbb14600a57${"00".repeat(10)}ff`;
const TEST_BLOCK = 18000000;
const TEST_API_KEY = "test-key-for-s031-suite-only";
const TEST_PEPPER = "test-pepper-for-s031-suite-only";
const FAST_PATH_BUDGET_MS = 5000;
const TIMING_RUNS = 25;

function testPorts(rpc: FakeRpcAdapter) {
  return {
    rpc,
    modelArtifacts: placeholderArtifact(),
    clock: new FakeClockAdapter(mustOk(Timestamp.of(1700000000000))),
  };
}

function testInput(requestId: string) {
  return {
    address: mustOk(Address.parse(TEST_ADDRESS)),
    block: mustOk(BlockNumber.of(TEST_BLOCK)),
    requestId: mustOk(RequestId.parse(requestId)),
    deadline: mustOk(Timestamp.of(1700000005000)),
    modelVersion: mustOk(ModelVersion.parse("0.1.0")),
    indexVersion: mustOk(IndexVersion.parse("1.0.0")),
    templateVersion: mustOk(TemplateVersion.parse("1.0.0")),
    catalogue: TEST_CATALOGUE,
  };
}

describe("performance, observability and cost frames (S-031)", () => {
  let server: RestServer;
  let baseUrl: string;
  let assessmentFake: FakeAssessmentModelAdapter;
  let services: AppServices;

  beforeAll(async () => {
    const codes = new Map<string, string>([
      [mustOk(Address.parse(TEST_ADDRESS)) as string, TEST_BYTECODE],
    ]);
    const rpc = new FakeRpcAdapter(codes, mustOk(BlockNumber.of(TEST_BLOCK)));
    services = createAppServices(testPorts(rpc),
  mustDefaultDetectorSet());
    assessmentFake = new FakeAssessmentModelAdapter({
      provider: "meta-model-api",
      modelId: "test-model-for-s031-only",
    });
    const assessmentService = createAssessmentService({
      analyze: services.analyzeToken,
      adapter: assessmentFake,
      promptVersion: mustOk(PromptVersion.parse("1.0.0")),
      dailyCapPerKey: 100,
      meter: createInMemoryAssessmentCostMeter(),
    });
    server = createRestServer({ detectors: mustDefaultDetectorSet(),
      services,
      assessmentService,
      apiKeys: [new SecretString(TEST_API_KEY)] as readonly SecretString[],
      apiKeyPepper: new SecretString(TEST_PEPPER),
      modelVersion: mustOk(ModelVersion.parse("0.1.0")),
      indexVersion: mustOk(IndexVersion.parse("1.0.0")),
      templateVersion: mustOk(TemplateVersion.parse("1.0.0")),
      catalogue: TEST_CATALOGUE,
    });
    baseUrl = await server.listen("127.0.0.1", 0);
  });

  afterAll(async () => {
    await server.close();
  });

  test("k101_fast_path_p95_within_5s", async () => {
    // Wall-clock on recorded fixtures (fakes, no network): the frozen fake
    // clock stamps every envelope with the same assessedAt, so it cannot
    // measure durations and is not used here; each run below is timed with
    // the runner clock around the shared analyze path. A deliberate sleep
    // in the path would inflate these durations and fail the budget, which
    // the unit test p95Ms_flags_a_slow_sample_over_a_5s_budget pins down.
    const durations: number[] = [];
    for (let run = 0; run < TIMING_RUNS; run += 1) {
      const started = Date.now();
      const outcome = await services.analyzeToken(testInput("123e4567-e89b-12d3-a456-426614174000"));
      expect(outcome.ok).toBe(true);
      durations.push(Date.now() - started);
    }
    expect(durations).toHaveLength(TIMING_RUNS);
    const p95 = p95Ms(durations);
    expect(p95).not.toBeNull();
    expect(p95 as number).toBeLessThanOrEqual(FAST_PATH_BUDGET_MS);
  });

  test("k107_no_request_zero_assessment_calls_and_cost", async () => {
    // A normal analyze request never requests an assessment: the provider
    // fake stays untouched and the request counters report zero assessment
    // calls with zero placeholder assessment cost.
    assessmentFake.reset();
    const counters = createRequestCounters();
    const outcome = await services.analyzeToken(
      testInput("223e4567-e89b-12d3-a456-426614174000"),
      counters,
    );
    expect(outcome.ok).toBe(true);
    expect(assessmentFake.callCount).toBe(0);
    const usage = counters.snapshot();
    expect(usage.assessmentCalls).toBe(0);
    expect(usage.assessmentCostUnits).toBe(0);
  });

  test("s031_analyze_response_reports_zero_assessment_cost", async () => {
    assessmentFake.reset();
    const response = await fetch(`${baseUrl}/v1/analyze?address=${TEST_ADDRESS}`, {
      headers: { "x-api-key": TEST_API_KEY },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("x-assessment-calls")).toBe("0");
    expect(response.headers.get("x-assessment-cost-units")).toBe("0");
    expect(assessmentFake.callCount).toBe(0);
  });

  test("s031_health_reports_cost_frame_without_secrets", async () => {
    const response = await fetch(`${baseUrl}/health`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body["status"]).toBe("ok");
    expect(body["apiVersion"]).toBe("v1");
    // Placeholder cost units only (I-14): the demo configuration carries
    // the running caps; the health frame names the unit, never a value.
    expect(body["costUnits"]).toBe("placeholder-cost-unit");
    expect(body["assessment"]).toEqual({
      provider: "meta-model-api",
      modelId: "test-model-for-s031-only",
    });
    const names: string[] = [];
    const collect = (value: unknown): void => {
      if (Array.isArray(value)) {
        for (const entry of value) {
          collect(entry);
        }
        return;
      }
      if (typeof value === "object" && value !== null) {
        for (const [key, entry] of Object.entries(value)) {
          names.push(key);
          collect(entry);
        }
      }
    };
    collect(body);
    expect(names.filter((name) => /key|token|secret|password|auth/i.test(name))).toEqual([]);
  });
});
