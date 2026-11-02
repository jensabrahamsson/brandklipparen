// Deterministic in-memory fake for AssessmentModelPort (A-23, K-305, K-309).
// Test-only adapter with no network, no clock and no randomness: every
// scenario returns the same canned outcome for the same input. The canned
// output always passes through validateAssessmentOutput, so the fake proves
// the validation real adapters must repeat. Call count and the last request
// stay observable, so tests verify zero assessment calls ahead of an
// explicit request (K-102, K-305) and evidence-only input (K-302).
// Placeholder text and limits are test-only values, never learned model
// values (K-210).
import { err } from "../../src/domain/result.ts";
import type { Result } from "../../src/domain/result.ts";
import {
  ExplanationSchemaVersion,
  ModelId,
  PromptVersion,
  SignalId,
} from "../../src/domain/types.ts";
import type {
  ModelId as ModelIdType,
  PromptVersion as PromptVersionType,
} from "../../src/domain/types.ts";
import type {
  AssessmentModelError,
  AssessmentModelPort,
  AssessmentProvider,
  CallContext,
  EvidenceList,
  MuseAssessment,
} from "../../src/ports/assessmentModel.ts";
import { validateAssessmentOutput } from "../../src/adapters/assessment/validateAssessment.ts";
import type { AssessmentContractScenario } from "../contract/assessmentModel.contract.ts";

export type FakeAssessmentModelOptions = {
  readonly provider: AssessmentProvider;
  readonly modelId: string;
  readonly promptVersion?: string;
  readonly explanationVersion?: string;
  readonly maxOutputChars?: number;
  readonly text?: string;
  readonly scenario?: AssessmentContractScenario;
};

const DEFAULT_PROMPT_VERSION = "1.0.0";
const DEFAULT_EXPLANATION_VERSION = "1.0.0";
const DEFAULT_MAX_OUTPUT_CHARS = 4000;
const PLACEHOLDER_TEXT = "Placeholder assessment text for tests only.";
const PLACEHOLDER_CLAIM = "Placeholder claim linked to the request evidence.";
const PLACEHOLDER_CHANGER = "0xe943a4b43ad372355be29445a2532cc0920a7108";

function mustParseModelId(raw: string): ModelIdType {
  const parsed = ModelId.parse(raw);
  if (!parsed.ok) {
    throw new Error(`fake assessment model id is invalid: ${parsed.error.message}`);
  }
  return parsed.value;
}

function mustParsePromptVersion(raw: string): PromptVersionType {
  const parsed = PromptVersion.parse(raw);
  if (!parsed.ok) {
    throw new Error(`fake assessment prompt version is invalid: ${parsed.error.message}`);
  }
  return parsed.value;
}

function mustParseExplanationVersion(raw: string): string {
  const parsed = ExplanationSchemaVersion.parse(raw);
  if (!parsed.ok) {
    throw new Error(
      `fake assessment explanation version is invalid: ${parsed.error.message}`,
    );
  }
  return raw;
}

// Canned claim link (C-27, F-25): the real owning signal id travels
// beside the evidence, with the legacy derivation as fallback.
function signalLinkOf(evidence: EvidenceList, index: number): string | null {
  const carried = evidence.links?.[index];
  if (carried !== undefined) {
    return carried as string;
  }
  const entry = evidence.evidence[index];
  if (entry === undefined) {
    return null;
  }
  const id = SignalId.of(evidence.codeHash, entry.selector);
  if (!id.ok) {
    return null;
  }
  return id.value as string;
}

export class FakeAssessmentModelAdapter implements AssessmentModelPort {
  private readonly providerName: AssessmentProvider;
  private readonly modelIdValue: ModelIdType;
  private readonly explanationVersion: string;
  private readonly maxOutputChars: number;
  private readonly placeholderText: string;
  private scenario: AssessmentContractScenario;
  private calls = 0;
  private lastEvidence: EvidenceList | undefined = undefined;
  private lastPromptVersion: PromptVersionType | undefined = undefined;
  private lastContext: CallContext | undefined = undefined;

  constructor(options: FakeAssessmentModelOptions) {
    this.providerName = options.provider;
    this.modelIdValue = mustParseModelId(options.modelId);
    mustParsePromptVersion(options.promptVersion ?? DEFAULT_PROMPT_VERSION);
    this.explanationVersion = mustParseExplanationVersion(
      options.explanationVersion ?? DEFAULT_EXPLANATION_VERSION,
    );
    this.maxOutputChars = options.maxOutputChars ?? DEFAULT_MAX_OUTPUT_CHARS;
    this.placeholderText = options.text ?? PLACEHOLDER_TEXT;
    this.scenario = options.scenario ?? "success";
  }

  setScenario(scenario: AssessmentContractScenario): void {
    this.scenario = scenario;
  }

  get callCount(): number {
    return this.calls;
  }

  get lastRequest():
    | { evidence: EvidenceList; promptVersion: PromptVersionType; ctx: CallContext }
    | undefined {
    if (
      this.lastEvidence === undefined ||
      this.lastPromptVersion === undefined ||
      this.lastContext === undefined
    ) {
      return undefined;
    }
    return {
      evidence: this.lastEvidence,
      promptVersion: this.lastPromptVersion,
      ctx: this.lastContext,
    };
  }

  reset(): void {
    this.calls = 0;
    this.lastEvidence = undefined;
    this.lastPromptVersion = undefined;
    this.lastContext = undefined;
  }

  provider(): AssessmentProvider {
    return this.providerName;
  }

  modelId(): ModelIdType {
    return this.modelIdValue;
  }

  async assess(
    evidence: EvidenceList,
    promptVersion: PromptVersionType,
    ctx: CallContext,
  ): Promise<Result<MuseAssessment, AssessmentModelError>> {
    this.calls += 1;
    this.lastEvidence = evidence;
    this.lastPromptVersion = promptVersion;
    this.lastContext = ctx;
    if (evidence.evidence.length === 0) {
      return err({ kind: "invalid-output", message: "fake assessment received no evidence" });
    }
    switch (this.scenario) {
      case "timeout":
        return err({ kind: "timeout", message: "fake assessment provider timed out" });
      case "rate-limited":
        return err({ kind: "rate-limited", message: "fake assessment provider rate limited" });
      case "unavailable":
        return err({ kind: "unavailable", message: "fake assessment provider unavailable" });
      case "invalid-output":
        return this.validated(
          evidence,
          this.canned(evidence, promptVersion, {
            claims: [{ text: PLACEHOLDER_CLAIM, signalLinks: [], temporality: this.marker() }],
          }),
          promptVersion,
        );
      case "output-too-large":
        return this.validated(
          evidence,
          this.canned(evidence, promptVersion, { text: "x".repeat(this.maxOutputChars + 1) }),
          promptVersion,
        );
      case "provider-mismatch":
        return this.validated(
          evidence,
          this.canned(evidence, promptVersion, {
            provider: "unknown-provider",
          }),
          promptVersion,
        );
      case "success":
        return this.validated(evidence, this.canned(evidence, promptVersion), promptVersion);
    }
  }

  private marker(): { kind: "can-change"; changer: string } {
    return { kind: "can-change", changer: PLACEHOLDER_CHANGER };
  }

  private canned(
    evidence: EvidenceList,
    promptVersion: PromptVersionType,
    override?: {
      text?: string;
      provider?: string;
      claims?: ReadonlyArray<{
        text: string;
        signalLinks: readonly string[];
        temporality: { kind: "can-change"; changer: string };
      }>;
    },
  ): unknown {
    const derived = signalLinkOf(evidence, 0);
    return {
      provider: override?.provider ?? this.providerName,
      modelId: this.modelIdValue as string,
      promptVersion: promptVersion as string,
      explanationVersion: this.explanationVersion,
      text: override?.text ?? this.placeholderText,
      claims: override?.claims ?? [
        {
          text: PLACEHOLDER_CLAIM,
          signalLinks: derived === null ? ["unlinked-claim-for-empty-evidence"] : [derived],
          temporality: this.marker(),
        },
      ],
    };
  }

  private validated(
    evidence: EvidenceList,
    raw: unknown,
    promptVersion: PromptVersionType,
  ): Result<MuseAssessment, AssessmentModelError> {
    return validateAssessmentOutput(raw, evidence, {
      provider: this.providerName,
      modelId: this.modelIdValue,
      promptVersion,
      maxOutputChars: this.maxOutputChars,
    });
  }
}
