// AssessmentModelPort: Muse contract assessment behind the selected provider
// (A-05, A-34, K-305, K-309). The port is owned by the core: the input is a
// closed evidence list derived from the deterministic analysis (K-302), and
// the output is untrusted model text that adapters must validate with
// validateAssessmentOutput before use (K-308, K-502, K-513). The assessment
// is optional and runs solely after an explicit request, after the
// deterministic result is computed and frozen; it never affects scores,
// signals or evidence (K-307, A-33). Calls stay server-side per I-13, so no
// provider key ever reaches the client (K-505).
import { err, ok } from "../domain/result.ts";
import type { Result } from "../domain/result.ts";
import type { Evidence as EvidenceType } from "../domain/evidence.ts";
import type { Claim as ClaimType } from "../domain/explain.ts";
import type {
  BlockNumber as BlockNumberType,
  CodeHash as CodeHashType,
  DomainError,
  ExplanationSchemaVersion as ExplanationSchemaVersionType,
  ModelId as ModelIdType,
  PromptVersion as PromptVersionType,
  RequestId as RequestIdType,
  Timestamp as TimestampType,
} from "../domain/types.ts";

// Selected provider behind the port (K-309). The same union appears in the
// validated configuration; the composition root maps one to the other.
// The third value is the vendor-neutral chat-completions shape for a
// temporary local endpoint during development; it shares the request and
// validation logic with the other two through the shared core.
export type AssessmentProvider = "meta-model-api" | "hosted-open-weights" | "generic-compatible";

// Closed evidence list: the sole input source for the assessment (K-302).
// Raw bytecode stays in the analysis path and never enters the prompt.
export type EvidenceList = {
  readonly codeHash: CodeHashType;
  readonly evidence: readonly EvidenceType[];
};

export const EvidenceList = {
  create(
    codeHash: CodeHashType,
    evidence: readonly EvidenceType[],
  ): Result<EvidenceList, DomainError> {
    if (evidence.length === 0) {
      return err({
        kind: "invalid-evidence",
        message: "assessment needs at least one evidence entry",
      });
    }
    return ok(Object.freeze({ codeHash, evidence: Object.freeze(evidence.slice()) }));
  },
};

// Validated assessment text with provider and model labelling (K-305).
// The text stays a separate field beside the deterministic result.
export type MuseAssessment = {
  readonly text: string;
  readonly claims: readonly ClaimType[];
  readonly promptVersion: PromptVersionType;
  readonly provider: AssessmentProvider;
  readonly modelId: ModelIdType;
  readonly explanationVersion: ExplanationSchemaVersionType;
};

// Error union per A-15. Every branch keeps the template text standing under
// K-306, with the assessment field stating the fallback. `unauthorized`
// covers rejected credentials (HTTP 401/403) and `rejected` covers a
// refused request (HTTP 400/404/422); both stay distinct from
// `invalid-output` so the fallback reason never blames validation for a
// provider refusal.
export type AssessmentModelError =
  | { kind: "timeout"; message: string }
  | { kind: "rate-limited"; message: string }
  | { kind: "invalid-output"; message: string; detail?: AssessmentInvalidDetail | undefined }
  | { kind: "output-too-large"; message: string; limitChars: number }
  | { kind: "provider-mismatch"; message: string }
  | { kind: "unavailable"; message: string }
  | { kind: "unauthorized"; message: string }
  | { kind: "rejected"; message: string };

// Parse stage of an invalid provider answer (S-136): JSON extraction
// covers the envelope, the message content and the fenced or wrapped
// payload; schema covers the key sets, value shapes and content rules;
// semantic covers the checks against the request evidence and the
// selected provider labels. Adapters log the stage with the failing
// path and check name at warn level, never the response content.
export type AssessmentInvalidStage = "extraction" | "schema" | "semantic";

// Fixed-vocabulary location of a failed validation check (S-136): the
// schema path names the field (for example `claims[0].signalLinks`)
// and the check names the rule (for example `unknown-signal`). Both
// are code constants, so a warn line carrying them can never leak
// response content, keys, headers or prompts.
export type AssessmentInvalidDetail = {
  readonly stage: AssessmentInvalidStage;
  readonly path: string;
  readonly check: string;
};

// Per-port limits per A-17. Values come from the operational configuration
// (I-08, I-14); the port only names the fields.
export type AssessmentModelLimits = {
  readonly deadlineMs: number;
  readonly maxBytesIn: number;
  readonly maxBytesOut: number;
  readonly maxConcurrency: number;
  readonly retryBudget: number;
};

// Correlation id, absolute deadline and block context per A-05.
export type CallContext = {
  readonly requestId: RequestIdType;
  readonly deadline: TimestampType;
  readonly block: BlockNumberType | "latest";
};

export interface AssessmentModelPort {
  assess(
    evidence: EvidenceList,
    promptVersion: PromptVersionType,
    ctx: CallContext,
  ): Promise<Result<MuseAssessment, AssessmentModelError>>;
  provider(): AssessmentProvider;
  modelId(): ModelIdType;
}
