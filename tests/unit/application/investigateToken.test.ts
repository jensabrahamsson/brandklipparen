// Graph runner tests (S-074, K-036, K-520, K-307, P-31, P-32, P-34, P-36).
// Test-first: these fail until src/application/investigateToken.ts lands.
import { describe, expect, test } from "vitest";
import * as fc from "fast-check";
import { Bytecode, CodeHash, ModelId, RequestId, Timestamp } from "../../../src/domain/types.ts";
import { ok } from "../../../src/domain/result.ts";
import type { Result } from "../../../src/domain/result.ts";
import type {
  InvestigationDecision,
  InvestigationModelError,
  InvestigationModelInput,
  InvestigationModelPort,
  InvestigationCallContext,
} from "../../../src/ports/investigationModel.ts";
import { InvestigationModelInput as InvestigationModelInputCtor } from "../../../src/ports/investigationModel.ts";
import {
  buildInvestigateSystemPrompt,
  collectedIdsForPrompt,
} from "../../../src/adapters/investigation/investigateChatCompletions.ts";
import {
  advanceInvestigation,
  buildInvestigationCatalogue,
  investigateToken,
  stripTraceTiming,
  emptyRunnerState,
} from "../../../src/application/investigateToken.ts";
import { meaningForEvidenceFinding } from "../../../src/domain/modelMeanings.ts";
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
    // The final step is reserved for conclude (M-2c): the eighth call is
    // a conclude-only step, so the repeated tool call is invalid there
    // and the forced conclusion fails too, ending with that typed
    // failure and the seven executed steps preserved.
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
    expect(stepCapped.reason.kind).toBe("invalid-decision");
    expect(stepCapped.partial.length).toBe(7);

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

  test("m2c_tool_call_on_the_conclude_only_step_is_invalid", () => {
    const tools = catalogue();
    const facts = frozenFacts();
    const lim = limits({ maxSteps: 3 });
    const finalState = { trace: [], collected: [], stepsUsed: 2, tokensSpent: 10, concluded: false };
    const rejected = advanceInvestigation(
      finalState,
      { kind: "run-tool", toolId: "evidence.list", args: {}, rationale: "One more read before concluding." },
      tools,
      facts,
      lim,
    );
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) {
      expect(rejected.error.reason.kind).toBe("invalid-decision");
      expect(rejected.error.stepsUsed).toBe(3);
    }
    const concludeAllowed = advanceInvestigation(
      finalState,
      { kind: "conclude", narrativeDraft: "Done. [E:sig-1]", rationale: "Conclude on the final step." },
      tools,
      facts,
      lim,
    );
    expect(concludeAllowed.ok).toBe(true);
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

describe("forced conclusion at the step budget (M-2c)", () => {
  function recordingAdapter(
    decisions: readonly InvestigationDecision[],
  ): InvestigationModelPort & { inputs: InvestigationModelInput[] } {
    const modelId = mustOk(ModelId.parse("meta-models/muse-spark-open-1026"));
    const inputs: InvestigationModelInput[] = [];
    let calls = 0;
    return {
      inputs,
      provider: () => "hosted-open-weights",
      modelId: () => modelId,
      async decide(input: InvestigationModelInput): Promise<Result<InvestigationDecision, InvestigationModelError>> {
        inputs.push(input);
        calls += 1;
        const next = decisions[Math.min(calls - 1, decisions.length - 1)] as InvestigationDecision;
        return ok(next);
      },
    };
  }

  const keepInspecting: InvestigationDecision = {
    kind: "run-tool",
    toolId: "evidence.list",
    args: {},
    rationale: "List the frozen evidence.",
  };

  test("m2c_model_that_never_concludes_ends_completed_with_the_forced_note", async () => {
    const forcedConclude: InvestigationDecision = {
      kind: "conclude",
      narrativeDraft: "The frozen evidence shows the finding. [E:sig-1] An uncited guess follows.",
      rationale: "Forced rationale: conclude from the frozen evidence.",
    };
    const adapter = recordingAdapter([keepInspecting, keepInspecting, keepInspecting, forcedConclude]);
    const done = await investigateToken(adapter, catalogue(), frozenFacts(), context(), limits({ maxSteps: 3 }), {
      now: () => 1000,
    });
    expect(done.status).toBe("done");
    if (done.status !== "done") {
      return;
    }
    expect(done.report.forcedConclusion).toBe(true);
    // The forced narrative passes the same citation check as any conclude.
    expect(done.report.narrative).toBe("The frozen evidence shows the finding. [E:sig-1]");
    expect(done.report.droppedClaims).toBe(1);
    expect(done.report.steps.length).toBe(2);
    // The open steps offered the catalogue; the conclude-only step and
    // the forced call offered no tools.
    expect(adapter.inputs.length).toBe(4);
    expect(adapter.inputs[0]?.concludeOnly).toBe(false);
    expect(adapter.inputs[0]?.tools.length).toBeGreaterThan(0);
    expect(adapter.inputs[2]?.concludeOnly).toBe(true);
    expect(adapter.inputs[2]?.tools).toEqual([]);
    expect(adapter.inputs[3]?.concludeOnly).toBe(true);
    expect(adapter.inputs[3]?.tools).toEqual([]);
  });

  test("m2c_invalid_forced_conclusion_ends_with_the_typed_failure", async () => {
    // The forced call repeats the tool call instead of concluding.
    const repeating = recordingAdapter([keepInspecting, keepInspecting, keepInspecting]);
    const repeated = await investigateToken(repeating, catalogue(), frozenFacts(), context(), limits({ maxSteps: 2 }), {
      now: () => 1000,
    });
    expect(repeated.status).toBe("failed");
    if (repeated.status !== "failed") {
      return;
    }
    expect(repeated.reason.kind).toBe("invalid-decision");
    expect(repeated.partial.length).toBe(1);
    // The forced call concludes with a blank draft.
    const blank: InvestigationDecision = {
      kind: "conclude",
      narrativeDraft: "   ",
      rationale: "Forced rationale with no draft.",
    };
    const blanking = recordingAdapter([keepInspecting, keepInspecting, blank]);
    const blanked = await investigateToken(blanking, catalogue(), frozenFacts(), context(), limits({ maxSteps: 2 }), {
      now: () => 1000,
    });
    expect(blanked.status).toBe("failed");
    if (blanked.status !== "failed") {
      return;
    }
    expect(blanked.reason.kind).toBe("invalid-decision");
  });

  test("m2c_early_conclude_is_unchanged", async () => {
    const adapter = recordingAdapter([
      keepInspecting,
      {
        kind: "conclude",
        narrativeDraft: "The frozen evidence shows the finding. [E:sig-1]",
        rationale: "Conclude from the frozen evidence.",
      },
    ]);
    const done = await investigateToken(adapter, catalogue(), frozenFacts(), context(), limits({ maxSteps: 8 }), {
      now: () => 1000,
    });
    expect(done.status).toBe("done");
    if (done.status !== "done") {
      return;
    }
    expect(done.report.forcedConclusion).toBe(false);
    expect(done.report.narrative).toBe("The frozen evidence shows the finding. [E:sig-1]");
    expect(done.report.steps.length).toBe(1);
    expect(adapter.inputs.length).toBe(2);
  });

  test("m2c_prompt_states_steps_left_and_must_conclude", () => {
    const modelId = mustOk(ModelId.parse("meta-models/muse-spark-open-1026"));
    const normal = buildInvestigateSystemPrompt({
      provider: "hosted-open-weights",
      modelId,
      stepsLeft: 5,
      concludeOnly: false,
    });
    expect(normal).toContain("Steps left in the step budget: 5.");
    expect(normal).toContain("Conclude as soon as the collected evidence answers the question");
    expect(normal).toContain("must call conclude");
    expect(normal).not.toContain("reply with a conclude decision only");
    const last = buildInvestigateSystemPrompt({
      provider: "hosted-open-weights",
      modelId,
      stepsLeft: 1,
      concludeOnly: true,
    });
    expect(last).toContain("Steps left in the step budget: 1.");
    expect(last).toContain("reply with a conclude decision only");
  });
});

describe("m2d conclude prompt and tolerant citation check", () => {
  function concludeScript(draft: string): readonly InvestigationDecision[] {
    return [
      { kind: "run-tool", toolId: "evidence.list", args: {}, rationale: "List the frozen evidence." },
      { kind: "conclude", narrativeDraft: draft, rationale: "Conclude from the frozen evidence." },
    ];
  }

  async function concludeWithDraft(draft: string) {
    return investigateToken(scriptedAdapter(concludeScript(draft)), catalogue(), frozenFacts(), context(), limits(), {
      now: () => 1000,
    });
  }

  test("m2d_each_tolerated_variant_is_kept_through_the_fake_loop", async () => {
    const variants = [
      "The frozen evidence shows the finding. [E: sig-1]",
      "The frozen evidence shows the finding. [e:sig-1]",
      "The frozen evidence shows the finding. [E:sig-1, sig-2]",
      "The frozen evidence shows the finding. [E:sig-1; sig-2]",
      "The frozen evidence shows the finding. [E:`sig-1`]",
      "The frozen evidence shows the finding [E:sig-1].",
    ];
    for (const draft of variants) {
      const done = await concludeWithDraft(draft);
      expect(done.status).toBe("done");
      if (done.status !== "done") {
        continue;
      }
      expect(done.report.droppedClaims).toBe(0);
      expect(done.report.dropReasons).toEqual({ uncited: 0, unknownId: 0 });
      expect(done.report.narrative).toBe(draft);
    }
  });

  test("m2d_unknown_id_drops_but_status_stays_done", async () => {
    const done = await concludeWithDraft("The frozen evidence shows the finding. [E:sig-ghost]");
    expect(done.status).toBe("done");
    if (done.status !== "done") {
      return;
    }
    expect(done.report.narrative).toBe("");
    expect(done.report.droppedClaims).toBe(1);
    expect(done.report.dropReasons).toEqual({ uncited: 0, unknownId: 1 });
  });

  test("m2d_uncited_sentence_drops_with_typed_reason", async () => {
    const done = await concludeWithDraft("A guess with no citation at all.");
    expect(done.status).toBe("done");
    if (done.status !== "done") {
      return;
    }
    expect(done.report.narrative).toBe("");
    expect(done.report.droppedClaims).toBe(1);
    expect(done.report.dropReasons).toEqual({ uncited: 1, unknownId: 0 });
  });

  test("m2d_mixed_draft_reports_split_reason_counts", async () => {
    const done = await concludeWithDraft(
      "The frozen evidence shows one finding. [E:sig-1] A guess with no citation. Another guess. [E:sig-ghost]",
    );
    expect(done.status).toBe("done");
    if (done.status !== "done") {
      return;
    }
    expect(done.report.narrative).toBe("The frozen evidence shows one finding. [E:sig-1]");
    expect(done.report.droppedClaims).toBe(2);
    expect(done.report.dropReasons).toEqual({ uncited: 1, unknownId: 1 });
  });

  test("m2d_prompt_shows_syntax_example_over_a_collected_id", () => {
    const modelId = mustOk(ModelId.parse("meta-models/muse-spark-open-1026"));
    const prompt = buildInvestigateSystemPrompt({
      provider: "hosted-open-weights",
      modelId,
      stepsLeft: 1,
      concludeOnly: true,
      collectedIds: ["signal:owner-blacklist", "signal:fee-cap"],
    });
    expect(prompt).toContain("[E:<id>]");
    expect(prompt).toContain("[E:signal:owner-blacklist]");
    expect(prompt).toContain("every sentence must end with one or more [E:<id>] markers");
    expect(prompt).toContain("Collected evidence ids (copy verbatim): signal:owner-blacklist, signal:fee-cap");
    expect(prompt).toContain("reply with a conclude decision only");
  });

  test("m2d_collected_ids_prefer_step_evidence_and_cap_the_list", () => {
    const facts = frozenFacts();
    const modelInput = mustOk(
      InvestigationModelInputCtor.create({
        codeHash: facts.codeHash,
        scoreBand: facts.scoreBand,
        signalIds: ["sig-1", "sig-2"],
        tools: [{ toolId: "evidence.list", description: "list", argNames: [] }],
        trace: [
          { step: 1, toolId: "evidence.list", rationale: "First.", evidenceIds: ["signal:fee-cap"] },
          { step: 2, toolId: "evidence.list", rationale: "Second.", evidenceIds: ["signal:fee-cap", "doc:fee-capability"] },
        ],
        budgets: { stepsLeft: 6, tokensLeft: 90000, deadlineMs: 20000 },
      }),
    );
    expect(collectedIdsForPrompt(modelInput)).toEqual(["signal:fee-cap", "doc:fee-capability"]);
    const emptyTrace = mustOk(
      InvestigationModelInputCtor.create({
        codeHash: facts.codeHash,
        scoreBand: facts.scoreBand,
        signalIds: ["sig-1"],
        tools: [{ toolId: "evidence.list", description: "list", argNames: [] }],
        trace: [],
        budgets: { stepsLeft: 8, tokensLeft: 90000, deadlineMs: 20000 },
      }),
    );
    expect(collectedIdsForPrompt(emptyTrace)).toEqual(["signal:sig-1"]);
    const manyEvidence = Array.from({ length: 25 }, (_, index) => `signal:ev-${index}`);
    const crowded = mustOk(
      InvestigationModelInputCtor.create({
        codeHash: facts.codeHash,
        scoreBand: facts.scoreBand,
        signalIds: ["sig-1"],
        tools: [{ toolId: "evidence.list", description: "list", argNames: [] }],
        trace: [{ step: 1, toolId: "evidence.list", rationale: "Many.", evidenceIds: manyEvidence }],
        budgets: { stepsLeft: 6, tokensLeft: 90000, deadlineMs: 20000 },
      }),
    );
    const capped = collectedIdsForPrompt(crowded);
    expect(capped.length).toBe(20);
    expect(capped[0]).toBe("signal:ev-0");
  });
});

describe("m02e runner carries meanings into model inputs", () => {
  test("m02e_frozen_meanings_reach_every_model_input_unchanged", async () => {
    const meaning = meaningForEvidenceFinding({
      id: "dev.brandklipparen.blacklist:blacklist",
      pluginId: "dev.brandklipparen.blacklist",
      title: "Privileged caller can set a mapping entry that gates the transfer path",
      selectors: ["0xa9059cbb"],
    });
    const withMeanings: FrozenInvestigationFacts = Object.freeze({
      ...frozenFacts(),
      meanings: Object.freeze([meaning]),
    });
    const seen: InvestigationModelInput[] = [];
    const modelId = mustOk(ModelId.parse("meta-models/muse-spark-open-1026"));
    const adapter: InvestigationModelPort = {
      provider: () => "hosted-open-weights",
      modelId: () => modelId,
      async decide(input: InvestigationModelInput): Promise<Result<InvestigationDecision, InvestigationModelError>> {
        seen.push(input);
        return ok({
          kind: "conclude",
          narrativeDraft: "The frozen evidence shows the finding. [E:sig-1]",
          rationale: "Conclude from the frozen evidence.",
        });
      },
    };
    const done = await investigateToken(adapter, catalogue(), withMeanings, context(), limits(), {
      now: () => 1000,
    });
    expect(done.status).toBe("done");
    expect(seen.length).toBeGreaterThan(0);
    for (const input of seen) {
      expect(input.meanings).toEqual([meaning]);
    }
  });
});
