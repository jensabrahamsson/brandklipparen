// Investigation caching and cost caps (S-077, K-036, I-14). Written first
// per A-21: a cache hit makes zero new model calls with the full key
// (code hash, prompt version, provider, model id); a miss runs at most
// one investigation per uncached request under the per-provider daily
// caps. All adapters are in-memory fakes; no network happens here.
import { describe, expect, test } from "vitest";
import { parseModelArtifact } from "../../src/domain/risk.ts";
import type { Result } from "../../src/domain/result.ts";
import {
  Address,
  ArtifactChecksum,
  BlockNumber,
  IndexVersion,
  ModelId,
  ModelVersion,
  RequestId,
  TemplateVersion,
  Timestamp,
} from "../../src/domain/types.ts";
import type { CapabilityCatalogue } from "../../src/domain/signals.ts";
import { createAppServices } from "../../src/application/analyzeToken.ts";
import type { AssessmentEnvelope } from "../../src/application/analyzeToken.ts";
import { createInvestigationService } from "../../src/application/investigationService.ts";
import type {
  InvestigationDecision,
  InvestigationModelError,
  InvestigationModelInput,
  InvestigationModelPort,
  InvestigationCallContext,
} from "../../src/ports/investigationModel.ts";
import { ok } from "../../src/domain/result.ts";
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

const TEST_ADDRESS = "0x0102030405060708090a0b0c0d0e0f1011121314";
const TEST_OTHER_ADDRESS = "0x02030405060708090a0b0c0d0e0f101112131415";
const TEST_BYTECODE = `0x8063a9059cbb14600a57${"00".repeat(10)}ff`;
const OTHER_BYTECODE = `0x80631234567814600a57${"00".repeat(10)}ff`;

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

// Trace-driven scripted adapter: lists evidence once, then concludes with
// a draft citing the first collected id. Deterministic with zero network.
function scriptedAdapter(counter: { calls: number }): InvestigationModelPort {
  return {
    provider: () => "hosted-open-weights",
    modelId: () => mustOk(ModelId.parse("meta-models/muse-spark-open-1026")),
    async decide(
      input: InvestigationModelInput,
    ): Promise<Result<InvestigationDecision, InvestigationModelError>> {
      counter.calls += 1;
      if (input.trace.length === 0) {
        return ok({
          kind: "run-tool",
          toolId: "evidence.list",
          args: {},
          rationale: "List the frozen evidence first.",
        });
      }
      const first = input.trace[0]?.evidenceIds[0] ?? "missing";
      return ok({
        kind: "conclude",
        narrativeDraft: `The frozen evidence shows the finding. [E:${first}]`,
        rationale: "Cached investigation concludes from the frozen evidence.",
      });
    },
  };
}

async function assessedEnvelope(address: string, bytecode: string): Promise<AssessmentEnvelope> {
  const codes = new Map<string, string>([[mustOk(Address.parse(address)) as string, bytecode]]);
  const services = createAppServices(
    {
      rpc: new FakeRpcAdapter(codes, mustOk(BlockNumber.of(18000000))),
      modelArtifacts: placeholderArtifact(),
      clock: new FakeClockAdapter(mustOk(Timestamp.of(1700000000000))),
    },
    mustDefaultDetectorSet(),
  );
  const analysed = await services.analyzeToken({
    address: mustOk(Address.parse(address)),
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

function investigationCtx(suffix: string): InvestigationCallContext {
  return {
    requestId: mustOk(RequestId.parse(`123e4567-e89b-12d3-a456-42661417${suffix}`)),
    deadline: mustOk(Timestamp.of(1700000000000 + 30000)),
    block: "latest",
  };
}

const QUOTA = Object.freeze({ apiKeyId: "test-key", day: "2026-10-27" });
const FROZEN_CLOCK = Object.freeze({ now: () => 1700000000000 });
const LIMITS = Object.freeze({ maxSteps: 8, maxTokens: 8000, deadlineMs: 30000, toolTimeoutMs: 1000 });

describe("investigation cache and caps", () => {
  test("k036_investigation_cached_per_codehash_prompt_provider_and_model", async () => {
    const counter = { calls: 0 };
    const detectors = mustDefaultDetectorSet();
    const first = createInvestigationService({
      adapter: scriptedAdapter(counter),
      detectors,
      docs: {},
      limits: LIMITS,
      promptVersion: "1.0.0",
      dailyCapPerKey: 100,
    });
    const envelope = await assessedEnvelope(TEST_ADDRESS, TEST_BYTECODE);
    const once = await first.investigateEnvelope(envelope, investigationCtx("4001"), FROZEN_CLOCK, QUOTA);
    expect(once.status).toBe("done");
    expect(counter.calls).toBeGreaterThan(0);
    const callsAfterMiss = counter.calls;
    const twice = await first.investigateEnvelope(envelope, investigationCtx("4002"), FROZEN_CLOCK, QUOTA);
    expect(twice).toEqual(once);
    expect(counter.calls).toBe(callsAfterMiss);

    // A different prompt version misses with the same code hash.
    const second = createInvestigationService({
      adapter: scriptedAdapter(counter),
      detectors,
      docs: {},
      limits: LIMITS,
      promptVersion: "2.0.0",
      dailyCapPerKey: 100,
    });
    const otherPrompt = await second.investigateEnvelope(envelope, investigationCtx("4003"), FROZEN_CLOCK, QUOTA);
    expect(otherPrompt.status).toBe("done");
    expect(counter.calls).toBeGreaterThan(callsAfterMiss);
  });

  test("k036_investigation_capped_key_makes_zero_calls", async () => {
    const counter = { calls: 0 };
    const detectors = mustDefaultDetectorSet();
    const service = createInvestigationService({
      adapter: scriptedAdapter(counter),
      detectors,
      docs: {},
      limits: LIMITS,
      promptVersion: "1.0.0",
      dailyCapPerKey: 1,
    });
    const firstEnvelope = await assessedEnvelope(TEST_ADDRESS, TEST_BYTECODE);
    const first = await service.investigateEnvelope(firstEnvelope, investigationCtx("4004"), FROZEN_CLOCK, QUOTA);
    expect(first.status).toBe("done");
    const callsAfterFirst = counter.calls;
    const secondEnvelope = await assessedEnvelope(TEST_OTHER_ADDRESS, OTHER_BYTECODE);
    const second = await service.investigateEnvelope(secondEnvelope, investigationCtx("4005"), FROZEN_CLOCK, QUOTA);
    expect(second.status).toBe("failed");
    expect(counter.calls).toBe(callsAfterFirst);
    if (second.status === "failed") {
      expect(second.reason.kind).toBe("budget-exhausted");
    }
  });
});
