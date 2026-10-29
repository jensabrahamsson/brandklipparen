// InvestigationModelPort: opt-in runtime agent loop on open weights
// (S-073, K-036, K-520, P-29, P-30). The port is owned by the core: the
// input is a closed frozen value (analysis summary, tool catalogue, trace
// so far, remaining budgets), and the output is one closed decision value
// (run one tool, or conclude with a narrative draft). Adapters never see
// tools, the registry or the graph; the runner validates every decision
// before acting on it (P-31). Model input and output are untrusted data:
// tool calls are schema-validated and narrative citations are re-checked
// deterministically by the runner (P-38, P-35). Key handling stays
// server-side, mirroring AssessmentModelPort (K-505, K-513).
import { err, ok } from "../domain/result.ts";
import type { Result } from "../domain/result.ts";
import type {
  BlockNumber as BlockNumberType,
  CodeHash as CodeHashType,
  ModelId as ModelIdType,
  RequestId as RequestIdType,
  Timestamp as TimestampType,
} from "../domain/types.ts";

// Providers for the investigation loop (P-30): the open-weights loop by
// default, or the vendor-neutral chat-completions shape sharing the
// assessment endpoint configuration for a temporary local endpoint
// during development. Exactly one is bound per run.
export type InvestigationProvider = "hosted-open-weights" | "generic-compatible";

// Closed decision union (P-31): the model proposes the next step only.
// The runner validates the decision against the current node, the
// allowlist and the remaining budgets before any transition.
export type InvestigationDecision =
  | {
      readonly kind: "run-tool";
      readonly toolId: string;
      readonly args: Readonly<Record<string, unknown>>;
      readonly rationale: string;
    }
  // The conclude rationale names why the trace answers the question
  // (S-112): the token report always carries it beside the narrative.
  | { readonly kind: "conclude"; readonly narrativeDraft: string; readonly rationale: string };

// One tool descriptor in the frozen catalogue (P-32): id, human summary
// and the declared argument names. Argument values are validated per tool
// by the runner before execution.
export type InvestigationToolDescriptor = {
  readonly toolId: string;
  readonly description: string;
  readonly argNames: readonly string[];
};

// One recorded step in the trace so far: chosen tools, rationales and
// returned evidence ids. Raw provider text from earlier steps never
// travels back into the model input (P-30).
export type InvestigationTraceEntry = {
  readonly step: number;
  readonly toolId: string;
  readonly rationale: string;
  readonly evidenceIds: readonly string[];
};

// Remaining budgets, mirrored from the runner limits (P-34).
export type InvestigationBudgets = {
  readonly stepsLeft: number;
  readonly tokensLeft: number;
  readonly deadlineMs: number;
};

// Closed, frozen model input (P-30): frozen analysis summary, tool
// catalogue, trace so far and remaining budgets. Nothing else enters.
export type InvestigationModelInput = {
  readonly codeHash: CodeHashType;
  readonly scoreBand: string;
  readonly signalIds: readonly string[];
  readonly tools: readonly InvestigationToolDescriptor[];
  readonly trace: readonly InvestigationTraceEntry[];
  readonly budgets: InvestigationBudgets;
};

export const InvestigationModelInput = {
  create(input: {
    readonly codeHash: CodeHashType;
    readonly scoreBand: string;
    readonly signalIds: readonly string[];
    readonly tools: readonly InvestigationToolDescriptor[];
    readonly trace: readonly InvestigationTraceEntry[];
    readonly budgets: InvestigationBudgets;
  }): Result<InvestigationModelInput, { kind: "invalid-investigation-input"; message: string }> {
    if (input.scoreBand.length === 0 || input.scoreBand.length > 64) {
      return err({ kind: "invalid-investigation-input", message: "score band must be a short label" });
    }
    if (input.tools.length === 0) {
      return err({ kind: "invalid-investigation-input", message: "tool catalogue must not be empty" });
    }
    if (input.budgets.stepsLeft < 0 || input.budgets.tokensLeft < 0 || input.budgets.deadlineMs <= 0) {
      return err({ kind: "invalid-investigation-input", message: "budgets must stay non-negative" });
    }
    return ok(
      Object.freeze({
        codeHash: input.codeHash,
        scoreBand: input.scoreBand,
        signalIds: Object.freeze(input.signalIds.slice()),
        tools: Object.freeze(input.tools.slice()),
        trace: Object.freeze(input.trace.slice()),
        budgets: Object.freeze({ ...input.budgets }),
      }),
    );
  },
};

// Error union per A-15. `not-configured` answers without a key with zero
// provider calls and the deterministic analysis standing (P-29).
export type InvestigationModelError =
  | { kind: "timeout"; message: string }
  | { kind: "rate-limited"; message: string }
  | { kind: "invalid-output"; message: string }
  | { kind: "output-too-large"; message: string; limitChars: number }
  | { kind: "provider-mismatch"; message: string }
  | { kind: "unavailable"; message: string }
  | { kind: "not-configured"; message: string };

// Per-port limits per A-17. Values come from the operational configuration;
// the port only names the fields.
export type InvestigationModelLimits = {
  readonly deadlineMs: number;
  readonly maxBytesIn: number;
  readonly maxBytesOut: number;
  readonly maxSteps: number;
  readonly maxTokens: number;
};

export type InvestigationCallContext = {
  readonly requestId: RequestIdType;
  readonly deadline: TimestampType;
  readonly block: BlockNumberType | "latest";
};

export interface InvestigationModelPort {
  decide(
    input: InvestigationModelInput,
    ctx: InvestigationCallContext,
  ): Promise<Result<InvestigationDecision, InvestigationModelError>>;
  provider(): InvestigationProvider;
  modelId(): ModelIdType;
}
