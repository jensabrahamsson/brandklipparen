// One-way assessment request with template fallback (S-024).
// Application service per A-02, A-33 and A-34: the deterministic result is
// computed and frozen ahead of any assessment call (K-307, A-19), the
// template explanation always stands (K-306), and the Muse assessment lands
// in a separate field only when the adapter returns schema-valid output.
// Every adapter error branch and every schema breach keeps the template text
// and records a static fallback reason that never carries the raw model
// output (K-502, M-05). This module performs no I/O of its own; the single
// outgoing call goes through AssessmentModelPort.
import { err, ok } from "../domain/result.ts";
import type { Result } from "../domain/result.ts";
import { renderExplanation } from "../domain/explain.ts";
import type { ExplainError, Explanation } from "../domain/explain.ts";
import { score } from "../domain/risk.ts";
import type { ModelArtifact, RiskResult } from "../domain/risk.ts";
import type { Signal, Temporality } from "../domain/signals.ts";
import type {
  PromptVersion as PromptVersionType,
  TemplateVersion as TemplateVersionType,
} from "../domain/types.ts";
import type {
  AssessmentModelError,
  AssessmentModelPort,
  CallContext,
  EvidenceList,
  MuseAssessment,
} from "../ports/assessmentModel.ts";

// Why the assessment field is absent. "not-requested" covers the run
// without an adapter; every other branch mirrors the port error that
// caused the fallback (A-15, K-306).
export type AssessmentFallback = {
  readonly errorKind: AssessmentModelError["kind"] | "not-requested";
  readonly reason: string;
};

// The frozen deterministic result beside the separate assessment field.
// The risk, explanation and evidence never move with the model output;
// only the assessment field and the fallback record differ (K-307).
export type RequestedAssessment = {
  readonly risk: RiskResult;
  readonly explanation: Explanation;
  readonly assessment: MuseAssessment | null;
  readonly fallback: AssessmentFallback | null;
};

export type RequestAssessmentInput = {
  readonly signals: readonly Signal[];
  readonly artifact: ModelArtifact;
  readonly evidence: EvidenceList;
  readonly templateVersion: TemplateVersionType;
  readonly observed: Temporality;
  readonly promptVersion: PromptVersionType;
  readonly ctx: CallContext;
  readonly adapter?: AssessmentModelPort | undefined;
};

// Static fallback reasons in English, one per branch. The raw model output
// never reaches a reason, a log message or an error branch (K-502, M-05).
function fallbackReasonFor(errorKind: AssessmentFallback["errorKind"]): string {
  switch (errorKind) {
    case "not-requested":
      return "assessment not requested; template explanation stands";
    case "timeout":
      return "assessment timed out; template explanation stands";
    case "rate-limited":
      return "assessment rate limited; template explanation stands";
    case "invalid-output":
      return "assessment output failed validation; template explanation stands";
    case "output-too-large":
      return "assessment output exceeded the size limit; template explanation stands";
    case "provider-mismatch":
      return "assessment provider label did not match; template explanation stands";
    case "unavailable":
      return "assessment provider unavailable; template explanation stands";
    case "unauthorized":
      return "assessment provider rejected the credentials; template explanation stands";
    case "rejected":
      return "assessment provider rejected the request; template explanation stands";
  }
}

// Numbers first, text second, provider last: score() and the template
// render run before any adapter call, so equal inputs give bit-identical
// risk and explanation with and without an assessment (K-307, A-33).
export async function requestAssessment(
  input: RequestAssessmentInput,
): Promise<Result<RequestedAssessment, ExplainError>> {
  const risk = score(input.signals, input.artifact);
  const rendered = renderExplanation({
    signals: input.signals,
    templateVersion: input.templateVersion,
    observed: input.observed,
  });
  if (!rendered.ok) {
    return err(rendered.error);
  }
  if (input.adapter === undefined) {
    return ok({
      risk,
      explanation: rendered.value,
      assessment: null,
      fallback: { errorKind: "not-requested", reason: fallbackReasonFor("not-requested") },
    });
  }
  const assessed = await input.adapter.assess(input.evidence, input.promptVersion, input.ctx);
  if (!assessed.ok) {
    return ok({
      risk,
      explanation: rendered.value,
      assessment: null,
      fallback: { errorKind: assessed.error.kind, reason: fallbackReasonFor(assessed.error.kind) },
    });
  }
  return ok({
    risk,
    explanation: rendered.value,
    assessment: assessed.value,
    fallback: null,
  });
}
