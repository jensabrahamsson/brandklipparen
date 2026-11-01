// On-request Muse contract assessment over the shared service (S-038).
// Application service per A-02, A-33 and A-34: the deterministic analysis
// runs first through the bound analyzeToken, then the assessment runs
// solely after this explicit request (K-305). Scores, signals and evidence
// pass through untouched; the assessment lands in a separate field with
// provider and model id labelling. The service enforces the full cache key
// (code hash, prompt version, template version, provider, model id), the
// per-key daily cost cap per provider, and the disabled path when no
// provider is configured: disabled means zero provider calls (K-102,
// K-309). This module performs no I/O of its own; cache and meter are
// injected in-memory stores, and the single outgoing call goes through
// AssessmentModelPort.
import { err, ok } from "../domain/result.ts";
import type { Result } from "../domain/result.ts";
import type { Evidence as EvidenceType } from "../domain/evidence.ts";
import { canonicalSerialize, modelInputKey } from "../domain/serialize.ts";
import type { CanonicalValue } from "../domain/serialize.ts";
import type { Temporality } from "../domain/signals.ts";
import type {
  Address as AddressType,
  BlockNumber as BlockNumberType,
  PromptVersion as PromptVersionType,
} from "../domain/types.ts";
import {
  assessmentToCanonical,
} from "./analyzeToken.ts";
import { envelopeMeanings } from "./modelMeanings.ts";
import type {
  AnalyzeTokenInput,
  AppServices,
  ApplicationError,
  AssessmentEnvelope,
} from "./analyzeToken.ts";
import type { AssessmentFallback } from "./requestAssessment.ts";
import { EvidenceList } from "../ports/assessmentModel.ts";
import type { RequestCounterSink } from "./observability.ts";
import type {
  AssessmentModelPort,
  AssessmentProvider,
  CallContext,
  MuseAssessment,
} from "../ports/assessmentModel.ts";

// Full assessment cache key (K-305, K-309, I-14, C-20): prompt version,
// template version, provider, model id and the exact model input: the
// closed evidence list (code hash, evidence entries and their owner/state
// meanings). A new value in any part misses, so a changed prompt,
// template, provider, model or evidence never serves stale text.
export type AssessmentCacheKeyParts = {
  readonly promptVersion: string;
  readonly templateVersion: string;
  readonly provider: AssessmentProvider;
  readonly modelId: string;
  readonly evidence: CanonicalValue;
};

export function assessmentCacheKeyOf(parts: AssessmentCacheKeyParts): string {
  return modelInputKey("assessment", {
    promptVersion: parts.promptVersion,
    templateVersion: parts.templateVersion,
    provider: parts.provider,
    modelId: parts.modelId,
    evidence: parts.evidence,
  });
}

// Injected assessment text store. The default in-memory map below serves
// tests and local runs; a shared volume adapter can replace it
// without touching the service. A hit costs zero provider calls and zero
// meter consumption (I-14).
export type AssessmentCacheStore = {
  readonly get: (key: string) => MuseAssessment | null;
  readonly set: (key: string, value: MuseAssessment) => void;
};

export function createInMemoryAssessmentCache(): AssessmentCacheStore {
  const store = new Map<string, MuseAssessment>();
  return Object.freeze({
    get: (key: string): MuseAssessment | null => store.get(key) ?? null,
    set: (key: string, value: MuseAssessment): void => {
      store.set(key, value);
    },
  });
}

// Per-key, per-provider, per-day consumption meter (K-107, K-305, I-14).
// checkAndRecord allows one assessment call per uncached request until the
// key reaches its daily cap; cache hits never reach the meter. The day
// travels as a YYYY-MM-DD string from the caller, so the service stays
// free of clock access.
export type AssessmentCostMeter = {
  readonly checkAndRecord: (
    apiKeyId: string,
    provider: AssessmentProvider,
    day: string,
    cap: number,
  ) => { readonly allowed: true } | { readonly allowed: false; readonly consumed: number };
  readonly consumed: (apiKeyId: string, provider: AssessmentProvider, day: string) => number;
};

export function createInMemoryAssessmentCostMeter(): AssessmentCostMeter {
  const counts = new Map<string, number>();
  const keyOf = (apiKeyId: string, provider: AssessmentProvider, day: string): string =>
    `${apiKeyId}|${provider}|${day}`;
  return Object.freeze({
    checkAndRecord: (
      apiKeyId: string,
      provider: AssessmentProvider,
      day: string,
      cap: number,
    ): { readonly allowed: true } | { readonly allowed: false; readonly consumed: number } => {
      const key = keyOf(apiKeyId, provider, day);
      const current = counts.get(key) ?? 0;
      if (current >= cap) {
        return { allowed: false, consumed: current };
      }
      counts.set(key, current + 1);
      return { allowed: true };
    },
    consumed: (apiKeyId: string, provider: AssessmentProvider, day: string): number =>
      counts.get(keyOf(apiKeyId, provider, day)) ?? 0,
  });
}

export type AssessmentServiceDeps = {
  // Bound deterministic analysis from the shared service (A-02, K-027).
  readonly analyze: AppServices["analyzeToken"];
  // Absent adapter means the feature is disabled through configuration:
  // every request returns the disabled outcome with zero provider calls.
  readonly adapter?: AssessmentModelPort | undefined;
  readonly promptVersion: PromptVersionType;
  // Placeholder operational default travels from the composition root when
  // the validated configuration carries no per-key cap (I-08, I-14); the
  // demo configuration always sets the versioned value.
  readonly dailyCapPerKey: number;
  // SEC-1 S-8: global daily cap across all keys for provider calls.
  // Absent means no global cap; the composition passes the validated
  // value or its conservative default. Cache hits never spend it.
  readonly globalDailyCap?: number | undefined;
  readonly cache?: AssessmentCacheStore | undefined;
  readonly meter?: AssessmentCostMeter | undefined;
};

export type AssessmentRequestInput = AnalyzeTokenInput & {
  readonly apiKeyId: string;
  readonly day: string;
};

export type TokenAssessmentOutcome =
  | {
      readonly kind: "assessed";
      readonly envelope: AssessmentEnvelope;
      readonly assessment: MuseAssessment | null;
      readonly fallback: AssessmentFallback | null;
      readonly fromCache: boolean;
    }
  | { readonly kind: "no-contract"; readonly target: AddressType; readonly block: BlockNumberType }
  | { readonly kind: "disabled"; readonly reason: string };

export type AssessmentService = {
  // An optional request-scoped sink counts the RPC calls of the underlying
  // analysis and the single assessment call of this request (K-107); cache
  // hits and capped keys record zero assessment calls.
  readonly requestForToken: (
    input: AssessmentRequestInput,
    counters?: RequestCounterSink | undefined,
  ) => Promise<Result<TokenAssessmentOutcome, ApplicationError>>;
  readonly promptVersion: PromptVersionType;
  readonly provider: AssessmentProvider | null;
  readonly modelId: string | null;
};

// Fallback reasons in English, one per branch. The raw model output never
// reaches a reason, a log message or an error branch (K-502, M-05).
function reasonFor(errorKind: AssessmentFallback["errorKind"]): string {
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

function temporalityToCanonical(temporality: Temporality): CanonicalValue {
  switch (temporality.kind) {
    case "can-change":
      return { kind: "can-change", changer: temporality.changer as string };
    case "can-change-unknown":
      return { kind: "can-change-unknown" };
    case "applies-now":
      return {
        kind: "applies-now",
        measuredValue: {
          value: temporality.measuredValue.value as string,
          slot: temporality.measuredValue.slot as string,
          block: temporality.measuredValue.block as number,
          at: temporality.measuredValue.at as number,
        },
        block: temporality.block as number,
        at: temporality.at as number,
      };
  }
}

function assessmentToCanonicalValue(assessment: MuseAssessment): CanonicalValue {
  return {
    claims: assessment.claims.map((claim) => ({
      text: claim.text,
      signalLinks: claim.signalLinks.map((link) => link as string),
      temporality: temporalityToCanonical(claim.temporality),
    })),
    explanationVersion: assessment.explanationVersion as string,
    modelId: assessment.modelId as string,
    promptVersion: assessment.promptVersion as string,
    provider: assessment.provider,
    text: assessment.text,
  };
}

// Canonical response body for REST and MCP: the envelope byte for byte as
// the plain analysis serialises it, plus the separate assessment field
// with provider and model labelling (K-023, K-025, K-305). Equal input
// gives equal bytes in every interface (K-027).
export function serializeTokenAssessment(
  outcome: Extract<TokenAssessmentOutcome, { kind: "assessed" }>,
): string {
  const envelopeValue = assessmentToCanonical(outcome.envelope) as {
    readonly [key: string]: CanonicalValue;
  };
  return canonicalSerialize({
    ...envelopeValue,
    assessment: outcome.assessment === null ? null : assessmentToCanonicalValue(outcome.assessment),
    assessmentFallback:
      outcome.fallback === null
        ? null
        : { errorKind: outcome.fallback.errorKind, reason: outcome.fallback.reason },
    fromCache: outcome.fromCache,
  });
}

// Minimal contract for the future web UI tab (S-029 owns the UI): the tab
// reads its state from the same service outcome as REST and MCP, so no
// interface invents its own assessment state.
export type AssessmentTabState =
  | { readonly state: "disabled"; readonly label: string }
  | { readonly state: "capped"; readonly label: string }
  | { readonly state: "fallback"; readonly reason: string }
  | {
      readonly state: "ready";
      readonly provider: AssessmentProvider;
      readonly modelId: string;
      readonly text: string;
      readonly fromCache: boolean;
    };

export function toAssessmentTab(outcome: TokenAssessmentOutcome): AssessmentTabState {
  switch (outcome.kind) {
    case "disabled":
      return { state: "disabled", label: "Assessment not configured" };
    case "no-contract":
      return { state: "fallback", reason: "No contract at this address; nothing to assess." };
    case "assessed": {
      if (outcome.assessment !== null) {
        return {
          state: "ready",
          provider: outcome.assessment.provider,
          modelId: outcome.assessment.modelId as string,
          text: outcome.assessment.text,
          fromCache: outcome.fromCache,
        };
      }
      if (outcome.fallback !== null && outcome.fallback.errorKind === "rate-limited") {
        return { state: "capped", label: outcome.fallback.reason };
      }
      return {
        state: "fallback",
        reason: outcome.fallback?.reason ?? "Template explanation stands.",
      };
    }
  }
}

export function createAssessmentService(deps: AssessmentServiceDeps): AssessmentService {
  const cache = deps.cache ?? createInMemoryAssessmentCache();
  const meter = deps.meter ?? createInMemoryAssessmentCostMeter();
  const globalSpent = new Map<string, number>();
  function globalExhausted(day: string): boolean {
    if (deps.globalDailyCap === undefined) {
      return false;
    }
    for (const spentDay of globalSpent.keys()) {
      if (spentDay !== day) {
        globalSpent.delete(spentDay);
      }
    }
    return (globalSpent.get(day) ?? 0) >= deps.globalDailyCap;
  }
  function recordGlobal(day: string): void {
    if (deps.globalDailyCap === undefined) {
      return;
    }
    globalSpent.set(day, (globalSpent.get(day) ?? 0) + 1);
  }
  const provider = deps.adapter?.provider() ?? null;
  const modelId = deps.adapter === undefined ? null : (deps.adapter.modelId() as string);

  async function requestForToken(
    input: AssessmentRequestInput,
    counters?: RequestCounterSink | undefined,
  ): Promise<Result<TokenAssessmentOutcome, ApplicationError>> {
    const adapter = deps.adapter;
    if (adapter === undefined) {
      return ok({
        kind: "disabled",
        reason: "Assessment is not configured: set an assessment provider to enable it.",
      });
    }
    const analysed = await deps.analyze(input, counters);
    if (!analysed.ok) {
      return err(analysed.error);
    }
    if (analysed.value.kind === "no-contract") {
      return ok({ kind: "no-contract", target: analysed.value.target, block: analysed.value.block });
    }
    const envelope = analysed.value.envelope;
    const flat: EvidenceType[] = [];
    for (const signal of envelope.signals) {
      for (const entry of signal.evidence) {
        flat.push(entry);
      }
    }
    if (flat.length === 0) {
      return ok({
        kind: "assessed",
        envelope,
        assessment: null,
        fallback: {
          errorKind: "invalid-output",
          reason: "no evidence available for assessment; template explanation stands",
        },
        fromCache: false,
      });
    }
    const first = flat[0];
    if (first === undefined) {
      return ok({
        kind: "assessed",
        envelope,
        assessment: null,
        fallback: {
          errorKind: "invalid-output",
          reason: "no evidence available for assessment; template explanation stands",
        },
        fromCache: false,
      });
    }
    // Meanings for the model input (M-02e): every signal and finding
    // travels with its stated meaning beside the cited evidence ids.
    const evidence = EvidenceList.create(
      envelope.codeHash,
      [first, ...flat.slice(1)],
      envelopeMeanings(envelope),
    );
    if (!evidence.ok) {
      return ok({
        kind: "assessed",
        envelope,
        assessment: null,
        fallback: { errorKind: "invalid-output", reason: reasonFor("invalid-output") },
        fromCache: false,
      });
    }
    // Cache lookup before the cap and the provider: a hit costs zero
    // provider calls and zero meter consumption (I-14). The key hashes
    // the exact evidence list, so another address's owner/state narrative
    // never serves here (C-20).
    const key = assessmentCacheKeyOf({
      promptVersion: deps.promptVersion as string,
      templateVersion: envelope.templateVersion as string,
      provider: adapter.provider(),
      modelId: adapter.modelId() as string,
      evidence: evidence.value as unknown as CanonicalValue,
    });
    const cached = cache.get(key);
    if (cached !== null) {
      return ok({ kind: "assessed", envelope, assessment: cached, fallback: null, fromCache: true });
    }
    // At most one assessment call per uncached request (I-14): the meter
    // closes the provider path at the daily per-key cap and the template
    // text stands.
    // Global provider-spend cap (S-8): checked before any meter spends,
    // so an exhausted day returns the unavailable fallback with zero
    // provider calls and the deterministic score and evidence standing.
    if (globalExhausted(input.day)) {
      return ok({
        kind: "assessed",
        envelope,
        assessment: null,
        fallback: { errorKind: "unavailable", reason: reasonFor("unavailable") },
        fromCache: false,
      });
    }
    const allowance = meter.checkAndRecord(input.apiKeyId, adapter.provider(), input.day, deps.dailyCapPerKey);
    if (!allowance.allowed) {
      return ok({
        kind: "assessed",
        envelope,
        assessment: null,
        fallback: {
          errorKind: "rate-limited",
          reason: "assessment daily cost cap reached for this key; template explanation stands",
        },
        fromCache: false,
      });
    }
    recordGlobal(input.day);
    const ctx: CallContext = { requestId: input.requestId, deadline: input.deadline, block: input.block };
    counters?.recordAssessmentCalls(1);
    const assessed = await adapter.assess(evidence.value, deps.promptVersion, ctx);
    if (!assessed.ok) {
      return ok({
        kind: "assessed",
        envelope,
        assessment: null,
        fallback: { errorKind: assessed.error.kind, reason: reasonFor(assessed.error.kind) },
        fromCache: false,
      });
    }
    cache.set(key, assessed.value);
    return ok({ kind: "assessed", envelope, assessment: assessed.value, fallback: null, fromCache: false });
  }

  return Object.freeze({
    requestForToken,
    promptVersion: deps.promptVersion,
    provider,
    modelId,
  });
}
