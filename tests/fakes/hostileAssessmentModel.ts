// Hostile fake for AssessmentModelPort (S-024, K-307, K-308, K-502).
// Test-only adapter with no network, no clock and no randomness. It crafts
// hostile provider payloads (injection-like text that still links to valid
// signals, extra fields, unknown signal links, oversize text and wrong
// provider labels) and runs each payload through validateAssessmentOutput,
// so hostile output yields the same typed errors the real adapters must
// produce. Call count and the last request stay observable, so tests verify
// the one-way chain: scores and evidence never move with the model output.
import { err } from "../../src/domain/result.ts";
import type { Result } from "../../src/domain/result.ts";
import {
  ModelId,
  PromptVersion,
  SignalId,
} from "../../src/domain/types.ts";
import type {
  CodeHash as CodeHashType,
  ModelId as ModelIdType,
  PromptVersion as PromptVersionType,
  Selector as SelectorType,
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

export type HostileAssessmentScenario =
  | "hostile-text-valid-links"
  | "extra-fields"
  | "unknown-links"
  | "oversize-text"
  | "provider-mismatch"
  | "timeout";

export type HostileAssessmentModelOptions = {
  readonly provider: AssessmentProvider;
  readonly modelId: string;
  readonly promptVersion?: string;
  readonly explanationVersion?: string;
  readonly maxOutputChars?: number;
  readonly hostileText?: string;
  readonly scenario?: HostileAssessmentScenario;
};

const DEFAULT_PROMPT_VERSION = "1.0.0";
const DEFAULT_EXPLANATION_VERSION = "1.0.0";
const DEFAULT_MAX_OUTPUT_CHARS = 4000;
const DEFAULT_HOSTILE_TEXT = "Hostile probe text for tests only.";
const HOSTILE_CHANGER = "0xe943a4b43ad372355be29445a2532cc0920a7108";

function mustParseModelId(raw: string): ModelIdType {
  const parsed = ModelId.parse(raw);
  if (!parsed.ok) {
    throw new Error(`hostile fake assessment model id is invalid: ${parsed.error.message}`);
  }
  return parsed.value;
}

function mustParsePromptVersion(raw: string): PromptVersionType {
  const parsed = PromptVersion.parse(raw);
  if (!parsed.ok) {
    throw new Error(`hostile fake assessment prompt version is invalid: ${parsed.error.message}`);
  }
  return parsed.value;
}

function signalLinkOf(codeHash: CodeHashType, selector: SelectorType): string | null {
  const id = SignalId.of(codeHash, selector);
  if (!id.ok) {
    return null;
  }
  return id.value as string;
}

export class HostileAssessmentModelAdapter implements AssessmentModelPort {
  private readonly providerName: AssessmentProvider;
  private readonly modelIdValue: ModelIdType;
  private readonly promptVersionValue: PromptVersionType;
  private readonly explanationVersion: string;
  private readonly maxOutputChars: number;
  private readonly hostileText: string;
  private scenario: HostileAssessmentScenario;
  private calls = 0;
  private lastEvidence: EvidenceList | undefined = undefined;
  private lastPromptVersion: PromptVersionType | undefined = undefined;
  private lastContext: CallContext | undefined = undefined;

  constructor(options: HostileAssessmentModelOptions) {
    this.providerName = options.provider;
    this.modelIdValue = mustParseModelId(options.modelId);
    this.promptVersionValue = mustParsePromptVersion(options.promptVersion ?? DEFAULT_PROMPT_VERSION);
    this.explanationVersion = options.explanationVersion ?? DEFAULT_EXPLANATION_VERSION;
    this.maxOutputChars = options.maxOutputChars ?? DEFAULT_MAX_OUTPUT_CHARS;
    this.hostileText = options.hostileText ?? DEFAULT_HOSTILE_TEXT;
    this.scenario = options.scenario ?? "hostile-text-valid-links";
  }

  setScenario(scenario: HostileAssessmentScenario): void {
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
      return err({ kind: "invalid-output", message: "hostile fake received no evidence" });
    }
    switch (this.scenario) {
      case "timeout":
        return err({ kind: "timeout", message: "hostile fake assessment provider timed out" });
      case "extra-fields":
        return this.validated(
          evidence,
          { ...this.basePayload(evidence, promptVersion), injectedField: "hostile extra field" },
          promptVersion,
        );
      case "unknown-links":
        return this.validated(
          evidence,
          {
            ...this.basePayload(evidence, promptVersion),
            claims: [
              {
                text: this.hostileText,
                signalLinks: ["unlinked-signal-id-for-tests"],
                temporality: this.marker(),
              },
            ],
          },
          promptVersion,
        );
      case "oversize-text":
        return this.validated(
          evidence,
          { ...this.basePayload(evidence, promptVersion), text: "x".repeat(this.maxOutputChars + 1) },
          promptVersion,
        );
      case "provider-mismatch":
        return this.validated(
          evidence,
          {
            ...this.basePayload(evidence, promptVersion),
            provider:
              this.providerName === "meta-model-api" ? "hosted-open-weights" : "meta-model-api",
          },
          promptVersion,
        );
      case "hostile-text-valid-links":
        return this.validated(evidence, this.basePayload(evidence, promptVersion), promptVersion);
    }
  }

  private marker(): { kind: "can-change"; changer: string } {
    return { kind: "can-change", changer: HOSTILE_CHANGER };
  }

  private basePayload(evidence: EvidenceList, promptVersion: PromptVersionType): Record<string, unknown> {
    const first = evidence.evidence[0];
    const derived =
      first === undefined ? null : signalLinkOf(evidence.codeHash, first.selector);
    return {
      provider: this.providerName,
      modelId: this.modelIdValue as string,
      promptVersion: promptVersion as string,
      explanationVersion: this.explanationVersion,
      text: this.hostileText,
      claims: [
        {
          text: this.hostileText,
          signalLinks: derived === null ? ["unlinked-signal-id-for-tests"] : [derived],
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
