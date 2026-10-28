// Investigation rationale coverage and synthetic marking (S-112, K-307):
// the token report always names its rationale and every executed tool is
// covered by the reason it ran; a synthetic input is marked unverified
// instead of presented as chain findings. Written first (red) per A-21:
// conclude decisions carry no rationale and the report names none. No
// network; the scripted adapter replays canned decisions.
import { describe, expect, test } from "vitest";
import { Bytecode, CodeHash, ModelId, RequestId, Timestamp } from "../../../src/domain/types.ts";
import type { Result } from "../../../src/domain/result.ts";
import type {
  InvestigationDecision,
  InvestigationModelError,
  InvestigationModelPort,
  InvestigationCallContext,
} from "../../../src/ports/investigationModel.ts";
import {
  buildInvestigationCatalogue,
  investigateToken,
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

function facts(synthetic?: boolean | undefined): FrozenInvestigationFacts {
  const code = mustOk(Bytecode.parse("0x6001600055"));
  return Object.freeze({
    codeHash: mustOk(CodeHash.of(code)),
    scoreBand: "High",
    signalIds: ["sig-1", "sig-2"],
    evidenceIds: ["sig-1", "sig-2"],
    score: 81,
    snapshot: Object.freeze({ score: 81, signals: ["sig-1"] }),
    ...(synthetic === undefined ? {} : { synthetic }),
  });
}

function limits(): InvestigationLimits {
  return Object.freeze({ maxSteps: 8, maxTokens: 100000, deadlineMs: 30000, toolTimeoutMs: 1000 });
}

function scriptedAdapter(decisions: readonly InvestigationDecision[]): InvestigationModelPort {
  const modelId = mustOk(ModelId.parse("meta-models/muse-spark-open-1026"));
  let calls = 0;
  return {
    provider: () => "hosted-open-weights",
    modelId: () => modelId,
    async decide(): Promise<Result<InvestigationDecision, InvestigationModelError>> {
      const next = decisions[Math.min(calls, decisions.length - 1)] as InvestigationDecision;
      calls += 1;
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

const CONCLUDE_RATIONALE = "Conclude: the trace names the capability evidence.";

function decisions(): readonly InvestigationDecision[] {
  return [
    {
      kind: "run-tool",
      toolId: "evidence.list",
      args: {},
      rationale: "List frozen evidence first.",
    },
    {
      kind: "run-tool",
      toolId: "detector.capability",
      args: {},
      rationale: "Re-run capability for structure.",
    },
    {
      kind: "conclude",
      narrativeDraft: "The frozen evidence shows the finding. [E:sig-1]",
      rationale: CONCLUDE_RATIONALE,
    },
  ];
}

describe("investigation rationale and synthetic marking (S-112)", () => {
  test("s019_investigate_names_rationale_per_tool", async () => {
    const tools = catalogue().tools.map((tool) => tool.toolId);
    expect(tools).toContain("evidence.list");
    const done = await investigateToken(
      scriptedAdapter(decisions()),
      catalogue(),
      facts(true),
      context(),
      limits(),
      { now: () => 1000 },
    );
    if (done.status !== "done") {
      throw new Error("expected the scripted investigation to conclude");
    }
    // The token report names its rationale beside the narrative.
    expect(done.report.rationale).toBe(CONCLUDE_RATIONALE);
    // Per-tool rationale coverage: every executed tool ran for a stated
    // non-empty reason.
    const used = done.report.steps.map((step) => step.toolId);
    expect(used).toEqual(["evidence.list", "detector.capability"]);
    for (const step of done.report.steps) {
      expect(step.rationale.trim().length).toBeGreaterThan(0);
    }
    // The synthetic input is marked unverified.
    expect(done.report.verifiedInput).toBe(false);
  });

  test("s019_chain_input_reports_verified", async () => {
    const done = await investigateToken(
      scriptedAdapter(decisions()),
      catalogue(),
      facts(),
      context(),
      limits(),
      { now: () => 1000 },
    );
    if (done.status !== "done") {
      throw new Error("expected the scripted investigation to conclude");
    }
    expect(done.report.verifiedInput).toBe(true);
  });
});
