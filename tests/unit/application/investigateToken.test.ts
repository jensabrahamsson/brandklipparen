// Graph runner tests (S-074, K-036, K-520, K-307, P-31, P-32, P-34, P-36).
// Test-first: these fail until src/application/investigateToken.ts lands.
import { describe, expect, test } from "vitest";
import * as fc from "fast-check";
import { Bytecode, CodeHash, ModelId, RequestId, Timestamp } from "../../../src/domain/types.ts";
import type { Result } from "../../../src/domain/result.ts";
import type {
  InvestigationDecision,
  InvestigationModelError,
  InvestigationModelPort,
  InvestigationCallContext,
} from "../../../src/ports/investigationModel.ts";
import {
  advanceInvestigation,
  buildInvestigationCatalogue,
  investigateToken,
  stripTraceTiming,
  emptyRunnerState,
} from "../../../src/application/investigateToken.ts";
import type {
  FrozenInvestigationFacts,
  InvestigationLimits,
} from "../../../src/application/investigateToken.ts";

function mustOk<T>(result: Result<T, { message: string }>): T {
  if (!result.ok) {
    throw new Error(`expected ok: ${result.error.message}`);
  }
  return result.value;
}

function frozenFacts(): FrozenInvestigationFacts {
  const code = mustOk(Bytecode.parse("0x6001600055"));
  return Object.freeze({
    codeHash: mustOk(CodeHash.of(code)),
    scoreBand: "High",
    signalIds: ["sig-1", "sig-2"],
    evidenceIds: ["sig-1", "sig-2"],
    score: 81,
    snapshot: Object.freeze({ score: 81, signals: ["sig-1"] }),
  });
}

function limits(override?: Partial<InvestigationLimits>): InvestigationLimits {
  return Object.freeze({
    maxSteps: 8,
    maxTokens: 100000,
    deadlineMs: 30000,
    toolTimeoutMs: 1000,
    ...(override ?? {}),
  });
}

function scriptedAdapter(decisions: readonly InvestigationDecision[]): InvestigationModelPort & { calls: number } {
  let calls = 0;
  const modelId = mustOk(ModelId.parse("meta-models/muse-spark-open-1026"));
  return {
    calls: 0,
    provider: () => "hosted-open-weights",
    modelId: () => modelId,
    async decide(): Promise<Result<InvestigationDecision, InvestigationModelError>> {
      calls += 1;
      (this as { calls: number }).calls = calls;
      const next = decisions[Math.min(calls - 1, decisions.length - 1)] as InvestigationDecision;
      const { ok } = await import("../../../src/domain/result.ts");
      return ok(next);
    },
  };
}

function context(): InvestigationCallContext {
  return {
    requestId: mustOk(RequestId.parse("123e4567-e89b-12d3-a456-426614174000")),
    deadline: mustOk(Timestamp.of(1761446400000)),
    block: "latest",
  };
}

function catalogue() {
  return buildInvestigationCatalogue({
    detectors: [{ pluginId: "capability", description: "capability detector", findings: ["sig-1"] }],
    evidenceIds: ["sig-1", "sig-2"],
    summary: "score band High",
    docs: { capability: "What the code lets someone do." },
  });
}

describe("investigation graph runner", () => {
  test("k520_runner_rejects_disallowed_tool_and_consumes_the_step", () => {
    const tools = catalogue();
    const facts = frozenFacts();
    const lim = limits();
    const unknown: InvestigationDecision = {
      kind: "run-tool",
      toolId: "detector.ghost",
      args: {},
      rationale: "Try an unknown tool.",
    };
    const rejectedUnknown = advanceInvestigation(emptyRunnerState(), unknown, tools, facts, lim);
    expect(rejectedUnknown.ok).toBe(false);
    if (!rejectedUnknown.ok) {
      expect(rejectedUnknown.error.reason.kind).toBe("invalid-decision");
      expect(rejectedUnknown.error.stepsUsed).toBe(1);
      expect(rejectedUnknown.error.partial).toEqual([]);
    }

    const afterConclude = advanceInvestigation(
      { trace: [], collected: [], stepsUsed: 2, tokensSpent: 10, concluded: true },
      { kind: "run-tool", toolId: "evidence.list", args: {}, rationale: "One more after conclude." },
      tools,
      facts,
      lim,
    );
    expect(afterConclude.ok).toBe(false);
    if (!afterConclude.ok) {
      expect(afterConclude.error.reason.kind).toBe("invalid-decision");
      expect(afterConclude.error.stepsUsed).toBe(3);
    }

    const malformed = advanceInvestigation(
      emptyRunnerState(),
      { kind: "run-tool", toolId: "evidence.list", args: { unexpected: 1 }, rationale: "Bad args." },
      tools,
      facts,
      lim,
    );
    expect(malformed.ok).toBe(false);
    if (!malformed.ok) {
      expect(malformed.error.reason.kind).toBe("invalid-decision");
      expect(malformed.error.stepsUsed).toBe(1);
    }
  });

  test("k520_step_token_and_wallclock_limits_end_with_partial_trace", async () => {
    const alwaysRun: InvestigationDecision = {
      kind: "run-tool",
      toolId: "evidence.list",
      args: {},
      rationale: "Keep inspecting.",
    };
    const stepCapped = await investigateToken(
      scriptedAdapter([alwaysRun]),
      catalogue(),
      frozenFacts(),
      context(),
      limits({ maxSteps: 8 }),
      { now: () => 1000 },
    );
    expect(stepCapped.status).toBe("failed");
    if (stepCapped.status !== "failed") {
      return;
    }
    expect(stepCapped.reason.kind).toBe("step-limit");
    expect(stepCapped.partial.length).toBe(8);

    const tokenCapped = await investigateToken(
      scriptedAdapter([alwaysRun]),
      catalogue(),
      frozenFacts(),
      context(),
      limits({ maxTokens: 1 }),
      { now: () => 1000 },
    );
    expect(tokenCapped.status).toBe("failed");
    if (tokenCapped.status !== "failed") {
      return;
    }
    expect(tokenCapped.reason.kind).toBe("token-limit");

    let tick = 0;
    const expired = await investigateToken(
      scriptedAdapter([alwaysRun]),
      catalogue(),
      frozenFacts(),
      context(),
      limits({ deadlineMs: 100 }),
      {
        now: () => {
          tick += 200;
          return tick;
        },
      },
    );
    expect(expired.status).toBe("failed");
    if (expired.status !== "failed") {
      return;
    }
    expect(expired.reason.kind).toBe("deadline");
    expect(expired.partial).toEqual([]);
  });

  test("k520_recorded_investigation_replays_bit_identical", async () => {
    const script: readonly InvestigationDecision[] = [
      { kind: "run-tool", toolId: "evidence.list", args: {}, rationale: "List frozen evidence." },
      {
        kind: "conclude",
        narrativeDraft: "The frozen evidence shows the finding. [E:sig-1]",
        rationale: "Conclude from the frozen evidence.",
      },
    ];
    const first = await investigateToken(scriptedAdapter(script), catalogue(), frozenFacts(), context(), limits(), {
      now: () => 1000,
    });
    const second = await investigateToken(scriptedAdapter(script), catalogue(), frozenFacts(), context(), limits(), {
      now: () => 9000,
    });
    expect(first.status).toBe("done");
    expect(second.status).toBe("done");
    if (first.status !== "done" || second.status !== "done") {
      return;
    }
    expect(stripTraceTiming(second.report.steps)).toEqual(stripTraceTiming(first.report.steps));
    expect(second.report.narrative).toBe(first.report.narrative);
    expect(second.report.droppedClaims).toBe(first.report.droppedClaims);
  });

  test("k520_investigation_leaves_score_and_evidence_unchanged", async () => {
    await fc.assert(
      fc.asyncProperty(fc.string({ maxLength: 120 }), async (draftTail) => {
        const facts = frozenFacts();
        const before = JSON.stringify(facts.snapshot);
        const script: readonly InvestigationDecision[] = [
          { kind: "run-tool", toolId: "detector.capability", args: {}, rationale: "Re-run capability." },
          {
            kind: "conclude",
            narrativeDraft: `Draft tail ${draftTail}. [E:sig-1]`,
            rationale: "Conclude from the frozen evidence.",
          },
        ];
        const envelope = await investigateToken(scriptedAdapter(script), catalogue(), facts, context(), limits(), {
          now: () => 1000,
        });
        expect(JSON.stringify(facts.snapshot)).toBe(before);
        expect(facts.score).toBe(81);
        expect(envelope.status === "done" || envelope.status === "failed").toBe(true);
      }),
      { numRuns: 25 },
    );
  });
});
