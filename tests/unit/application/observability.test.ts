// S-031 observability and cost frame unit tests (K-101, K-104, K-107).
// Written first per A-21 (red): src/application/observability.ts does not
// exist yet, so every import below fails until the frame lands. Cost units
// are placeholders only (K-210, I-14): no learned values live here.
import { describe, expect, test } from "vitest";
import {
  PLACEHOLDER_ASSESSMENT_COST_PER_CALL,
  PLACEHOLDER_COST_UNIT,
  buildAnalysisLogRecord,
  buildHealthCostFrame,
  createRequestCounters,
  p95Ms,
  withCountedAssessment,
  withCountedRpc,
} from "../../../src/application/observability.ts";
import { FakeAssessmentModelAdapter } from "../../fakes/fakeAssessmentModel.ts";
import { FakeRpcAdapter } from "../../fakes/fakeRpc.ts";
import {
  Address,
  BlockNumber,
  Bytecode,
  CodeHash,
  PromptVersion,
  RequestId,
  Timestamp,
} from "../../../src/domain/types.ts";
import type { Result } from "../../../src/domain/result.ts";
import { EvidenceList } from "../../../src/ports/assessmentModel.ts";
import { Evidence } from "../../../src/domain/evidence.ts";
import { Selector } from "../../../src/domain/types.ts";

function mustOk<T, E extends { message: string }>(result: Result<T, E>): T {
  if (!result.ok) {
    throw new Error(`expected ok, got error: ${result.error.message}`);
  }
  return result.value;
}

describe("p95 helper over measured durations (K-101)", () => {
  test("p95Ms_returns_null_for_empty_samples", () => {
    expect(p95Ms([])).toBeNull();
  });

  test("p95Ms_returns_single_sample_for_single_run", () => {
    expect(p95Ms([42])).toBe(42);
  });

  test("p95Ms_uses_nearest_rank_over_sorted_copy", () => {
    // Nearest rank: ceil(0.95 * 5) = 5, so the fifth of five sorted values.
    expect(p95Ms([30, 10, 50, 20, 40])).toBe(50);
  });

  test("p95Ms_leaves_input_untouched", () => {
    const samples = Object.freeze([30, 10, 50, 20, 40]);
    p95Ms(samples);
    expect([...samples]).toEqual([30, 10, 50, 20, 40]);
  });

  test("p95Ms_flags_a_slow_sample_over_a_5s_budget", () => {
    // Meaningfulness guard for k101_fast_path_p95_within_5s: a deliberate
    // slow run (for example a 6s sleep in the path) lands above the budget,
    // so the timing test cannot pass while the path is slow.
    const samples = [12, 9, 14, 11, 6000];
    const p95 = p95Ms(samples);
    expect(p95).not.toBeNull();
    expect(p95 as number).toBeGreaterThan(5000);
  });
});

describe("request-scoped cost counters (K-107)", () => {
  test("s031_fresh_counters_report_zero_calls_and_zero_cost", () => {
    const counters = createRequestCounters();
    expect(counters.snapshot()).toEqual({
      rpcCalls: 0,
      assessmentCalls: 0,
      assessmentCostUnits: 0,
      costUnit: PLACEHOLDER_COST_UNIT,
    });
  });

  test("s031_assessment_cost_is_calls_times_placeholder_rate", () => {
    const counters = createRequestCounters();
    counters.recordAssessmentCalls(3);
    counters.recordRpcCalls(2);
    expect(counters.snapshot()).toEqual({
      rpcCalls: 2,
      assessmentCalls: 3,
      assessmentCostUnits: 3 * PLACEHOLDER_ASSESSMENT_COST_PER_CALL,
      costUnit: PLACEHOLDER_COST_UNIT,
    });
  });

  test("s031_counted_rpc_delegates_and_counts_each_call", async () => {
    const address = mustOk(Address.parse("0x0102030405060708090a0b0c0d0e0f1011121314"));
    const codes = new Map<string, string>([
      [address as string, `0x8063a9059cbb14600a57${"00".repeat(10)}ff`],
    ]);
    const rpc = new FakeRpcAdapter(codes, mustOk(BlockNumber.of(18000000)));
    const counters = createRequestCounters();
    const counted = withCountedRpc(rpc, counters);
    const ctx = {
      requestId: mustOk(RequestId.parse("123e4567-e89b-12d3-a456-426614174000")),
      deadline: mustOk(Timestamp.of(1700000005000)),
      block: mustOk(BlockNumber.of(18000000)),
    };
    const fetched = await counted.getCode(address, ctx);
    expect(fetched.ok).toBe(true);
    expect(counters.snapshot().rpcCalls).toBe(1);
    expect(counters.snapshot().assessmentCalls).toBe(0);
  });

  test("s031_counted_assessment_port_counts_each_call", async () => {
    const fake = new FakeAssessmentModelAdapter({
      provider: "meta-model-api",
      modelId: "test-model-for-s031-only",
    });
    const counters = createRequestCounters();
    const counted = withCountedAssessment(fake, counters);
    const codeHash = mustOk(CodeHash.of(mustOk(Bytecode.parse("0x6001600201"))));
    const evidence = mustOk(
      EvidenceList.create(codeHash, [
        mustOk(Evidence.create({ selector: mustOk(Selector.parse("0xa9059cbb")) })),
      ]),
    );
    const ctx = {
      requestId: mustOk(RequestId.parse("123e4567-e89b-12d3-a456-426614174000")),
      deadline: mustOk(Timestamp.of(1700000005000)),
      block: mustOk(BlockNumber.of(18000000)),
    };
    const assessed = await counted.assess(
      evidence,
      mustOk(PromptVersion.parse("1.0.0")),
      ctx,
    );
    expect(assessed.ok).toBe(true);
    expect(counters.snapshot().assessmentCalls).toBe(1);
    expect(counters.snapshot().assessmentCostUnits).toBe(
      PLACEHOLDER_ASSESSMENT_COST_PER_CALL,
    );
  });
});

describe("analysis log record (K-104)", () => {
  test("k104_analysis_log_has_required_fields", () => {
    const record = buildAnalysisLogRecord({
      requestId: "123e4567-e89b-12d3-a456-426614174000",
      address: "0x0102030405060708090a0b0c0d0e0f1011121314",
      codeHash: "code-hash-for-s031-only",
      modelVersion: "0.1.0",
      stepDurationsMs: { fastPathMs: 120 },
      outcome: "assessed",
      rpcCallCount: 4,
      assessmentCallCount: 0,
      assessmentCostUnits: 0,
      cacheHit: false,
    });
    expect(record.requestId).toBe("123e4567-e89b-12d3-a456-426614174000");
    expect(record.address).toBe("0x0102030405060708090a0b0c0d0e0f1011121314");
    expect(record.codeHash).toBe("code-hash-for-s031-only");
    expect(record.modelVersion).toBe("0.1.0");
    expect(record.stepDurationsMs).toEqual({ fastPathMs: 120 });
    expect(record.outcome).toBe("assessed");
    expect(record.rpcCallCount).toBe(4);
    expect(record.assessmentCallCount).toBe(0);
    expect(record.assessmentCostUnits).toBe(0);
    expect(record.cacheHit).toBe(false);
    expect(record.costUnit).toBe(PLACEHOLDER_COST_UNIT);
    expect(Object.isFrozen(record)).toBe(true);
  });
});

describe("health cost frame (K-104, K-107)", () => {
  test("s031_health_frame_names_provider_without_secrets", () => {
    const frame = buildHealthCostFrame({
      assessment: { provider: "meta-model-api", modelId: "test-model-for-s031-only" },
    });
    expect(frame).toEqual({
      costUnit: PLACEHOLDER_COST_UNIT,
      assessmentCostPerCall: PLACEHOLDER_ASSESSMENT_COST_PER_CALL,
      assessment: { provider: "meta-model-api", modelId: "test-model-for-s031-only" },
    });
    const text = JSON.stringify(frame);
    expect(/key|token|secret|password|auth/i.test(text)).toBe(false);
  });

  test("s031_health_frame_marks_disabled_assessment", () => {
    const frame = buildHealthCostFrame({ assessment: { disabled: true } });
    expect(frame.assessment).toEqual({ disabled: true });
  });
});
