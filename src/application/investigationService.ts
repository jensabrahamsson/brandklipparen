// Investigation service over the shared analysis (S-075, K-036, K-027).
// Application service per A-02: the deterministic analysis runs first and
// freezes, then the investigation loop runs solely after this explicit
// request. Detector tools serve the frozen finding ids from the analysis
// envelope: detectors are deterministic over frozen facts, so a re-run
// over the same frozen input would agree by the detector contract (P-03),
// and serving the frozen ids keeps bytecode out of the loop. Scores,
// probabilities, signals and evidence pass through untouched; the
// investigation lands in its own envelope field (K-307, P-33).
import { canonicalSerialize } from "../domain/serialize.ts";
import type { CanonicalValue } from "../domain/serialize.ts";
import { serializeAssessment } from "./analyzeToken.ts";
import type { AssessmentEnvelope, DetectorSet } from "./analyzeToken.ts";
import {
  buildInvestigationCatalogue,
  investigateToken,
} from "./investigateToken.ts";
import type {
  FrozenInvestigationFacts,
  InvestigationCatalogue,
  InvestigationEnvelope,
  InvestigationLimits,
  InvestigateHooks,
} from "./investigateToken.ts";
import type { InvestigationTraceStep } from "../domain/investigation.ts";
import type { InvestigationModelPort, InvestigationCallContext } from "../ports/investigationModel.ts";

// Score band labels shared with the web risk bands (0-29 Low, 30-59
// Elevated, 60-100 High per the design): the frozen summary carries the
// band only, never the score, so the model cannot recompute numbers.
export function scoreBandOf(score: number): string {
  if (score >= 60) {
    return "High";
  }
  if (score >= 30) {
    return "Elevated";
  }
  return "Low";
}

// Frozen facts derived from one assessed envelope (P-32): code hash,
// score band, signal ids and the collected evidence ids (one
// `signal:<id>` per signal plus every plugin finding id). The score and
// the snapshot travel for the unchanged-proof only; they never enter the
// model input.
export function frozenFactsOfEnvelope(envelope: AssessmentEnvelope): FrozenInvestigationFacts {
  const signalIds = envelope.signals.map((signal) => signal.id as string);
  const evidenceIds: string[] = signalIds.map((id) => `signal:${id}`);
  for (const entry of envelope.pluginResults) {
    for (const finding of entry.findings) {
      evidenceIds.push(finding.id);
    }
  }
  return Object.freeze({
    codeHash: envelope.codeHash,
    scoreBand: scoreBandOf(envelope.score as number),
    signalIds: Object.freeze(signalIds),
    evidenceIds: Object.freeze(evidenceIds),
    score: envelope.score as number,
    snapshot: snapshotOfEnvelope(envelope),
  });
}

function snapshotOfEnvelope(envelope: AssessmentEnvelope): unknown {
  const plain = {
    score: envelope.score,
    probabilities: envelope.probabilities,
    signals: envelope.signals.map((signal) => signal.id),
    evidence: envelope.signals.map((signal) => signal.evidence),
    pluginResults: envelope.pluginResults.map((entry) => ({
      pluginId: entry.pluginId,
      outcome: entry.outcome,
      findings: entry.findings.map((finding) => finding.id),
    })),
  };
  return JSON.parse(canonicalSerialize(plain as CanonicalValue)) as unknown;
}

// Catalogue derived from the one registry (P-32): one `detector.<id>` per
// registered entry serving its frozen finding ids, plus the frozen-fact
// readers. Docs excerpts travel as quoted data under the caller's cap.
export function catalogueOfEnvelope(
  detectors: DetectorSet,
  envelope: AssessmentEnvelope,
  docs: Readonly<Record<string, string>>,
): InvestigationCatalogue {
  const findingsByPlugin = new Map<string, string[]>();
  for (const entry of envelope.pluginResults) {
    findingsByPlugin.set(entry.pluginId as string, entry.findings.map((finding) => finding.id));
  }
  return buildInvestigationCatalogue({
    detectors: detectors.registry.entries.map((plugin) => ({
      pluginId: plugin.manifest.id as string,
      description: plugin.manifest.description,
      findings: findingsByPlugin.get(plugin.manifest.id as string) ?? [],
    })),
    evidenceIds: frozenFactsOfEnvelope(envelope).evidenceIds.slice(),
    summary: `score band ${scoreBandOf(envelope.score as number)}`,
    docs,
  });
}

// Canonical response body shared by REST and MCP (K-027, P-37): the
// deterministic assessment bytes plus the investigation in its own fields
// with provider and model id labelling. Equal code hash gives equal bytes
// in every interface.
export function serializeTokenInvestigation(
  envelope: AssessmentEnvelope,
  investigation: InvestigationEnvelope,
  provider: string,
  modelId: string,
): string {
  const base = JSON.parse(serializeAssessment(envelope)) as Record<string, unknown>;
  return canonicalSerialize({
    ...base,
    investigation: investigation as CanonicalValue,
    investigationProvider: provider,
    investigationModel: modelId,
  });
}

// Full investigation cache key (S-077, K-036, I-14): code hash, prompt
// version, provider and model id. A new value in any part misses, so a
// changed prompt, provider or model never serves a stale narrative.
export type InvestigationCacheKeyParts = {
  readonly codeHash: string;
  readonly promptVersion: string;
  readonly provider: string;
  readonly modelId: string;
};

export function investigationCacheKeyOf(parts: InvestigationCacheKeyParts): string {
  return [
    "investigation",
    parts.codeHash,
    parts.promptVersion,
    parts.provider,
    parts.modelId,
  ].join("|");
}

export type InvestigationDoneReport = Extract<InvestigationEnvelope, { status: "done" }>["report"];

// Injected investigation report store. The default in-memory map below
// serves tests and local runs; only `done` reports are stored: failed
// runs depend on the live budgets and are never served stale. A hit
// costs zero provider calls and zero meter consumption (I-14).
export type InvestigationCacheStore = {
  readonly get: (key: string) => InvestigationDoneReport | null;
  readonly set: (key: string, value: InvestigationDoneReport) => void;
};

export function createInMemoryInvestigationCache(): InvestigationCacheStore {
  const store = new Map<string, InvestigationDoneReport>();
  return Object.freeze({
    get: (key: string): InvestigationDoneReport | null => store.get(key) ?? null,
    set: (key: string, value: InvestigationDoneReport): void => {
      store.set(key, value);
    },
  });
}

// Per-key, per-provider, per-day consumption meter (S-077, I-14).
// checkAndRecord allows one investigation per uncached request until the
// key reaches its daily cap; cache hits never reach the meter. The day
// travels as a YYYY-MM-DD string from the caller, so the service stays
// free of clock access. Mirrors the assessment meter.
export type InvestigationCostMeter = {
  readonly checkAndRecord: (
    apiKeyId: string,
    provider: string,
    day: string,
    cap: number,
  ) => { readonly allowed: true } | { readonly allowed: false; readonly consumed: number };
  readonly consumed: (apiKeyId: string, provider: string, day: string) => number;
};

export function createInMemoryInvestigationCostMeter(): InvestigationCostMeter {
  const counts = new Map<string, number>();
  const keyOf = (apiKeyId: string, provider: string, day: string): string =>
    `${apiKeyId}|${provider}|${day}`;
  return Object.freeze({
    checkAndRecord: (
      apiKeyId: string,
      provider: string,
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
    consumed: (apiKeyId: string, provider: string, day: string): number =>
      counts.get(keyOf(apiKeyId, provider, day)) ?? 0,
  });
}

// Placeholder operational defaults for local and CI runs (I-08): the demo
// configuration always sets the versioned prompt version and per-key cap.
// One investigation costs several model calls, so the placeholder cap sits
// below the assessment placeholder.
export const PLACEHOLDER_INVESTIGATION_PROMPT_VERSION = "1.0.0";
export const PLACEHOLDER_INVESTIGATION_DAILY_CAP_PER_KEY = 10;

// Quota identity for the cost meter (S-077, I-14): the stable key id from
// the driving adapter and the current day. Absent quota skips the meter;
// the cache still applies.
export type InvestigationQuota = {
  readonly apiKeyId: string;
  readonly day: string;
};

export type InvestigationServiceOptions = {
  readonly adapter: InvestigationModelPort;
  readonly detectors: DetectorSet;
  readonly docs: Readonly<Record<string, string>>;
  readonly limits: InvestigationLimits;
  readonly promptVersion?: string | undefined;
  readonly dailyCapPerKey?: number | undefined;
  readonly cache?: InvestigationCacheStore | undefined;
  readonly meter?: InvestigationCostMeter | undefined;
};

export type InvestigationService = {
  readonly investigateEnvelope: (
    envelope: AssessmentEnvelope,
    ctx: InvestigationCallContext,
    hooks: InvestigateHooks,
    quota?: InvestigationQuota | undefined,
  ) => Promise<InvestigationEnvelope>;
  readonly frozenFactsOf: (envelope: AssessmentEnvelope) => FrozenInvestigationFacts;
  readonly catalogueOf: (envelope: AssessmentEnvelope) => InvestigationCatalogue;
  readonly provider: () => string;
  readonly modelId: () => string;
};

export function createInvestigationService(options: InvestigationServiceOptions): InvestigationService {
  const cache = options.cache ?? createInMemoryInvestigationCache();
  const meter = options.meter ?? createInMemoryInvestigationCostMeter();
  const promptVersion = options.promptVersion ?? PLACEHOLDER_INVESTIGATION_PROMPT_VERSION;
  const dailyCapPerKey = options.dailyCapPerKey ?? PLACEHOLDER_INVESTIGATION_DAILY_CAP_PER_KEY;
  return Object.freeze({
    investigateEnvelope: async (envelope, ctx, hooks, quota) => {
      const provider = options.adapter.provider();
      const modelId = options.adapter.modelId() as string;
      const key = investigationCacheKeyOf({
        codeHash: envelope.codeHash as string,
        promptVersion,
        provider,
        modelId,
      });
      const hit = cache.get(key);
      if (hit !== null) {
        return { status: "done", report: hit, limits: options.limits };
      }
      if (quota !== undefined) {
        const decision = meter.checkAndRecord(quota.apiKeyId, provider, quota.day, dailyCapPerKey);
        if (!decision.allowed) {
          return {
            status: "failed",
            reason: { kind: "budget-exhausted", message: "daily investigation budget spent for this key" },
            partial: [],
            collectedEvidenceIds: [],
            limits: options.limits,
          };
        }
      }
      const result = await investigateToken(
        options.adapter,
        catalogueOfEnvelope(options.detectors, envelope, options.docs),
        frozenFactsOfEnvelope(envelope),
        ctx,
        options.limits,
        hooks,
      );
      if (result.status === "done") {
        cache.set(key, result.report);
      }
      return result;
    },
    frozenFactsOf: (envelope) => frozenFactsOfEnvelope(envelope),
    catalogueOf: (envelope) => catalogueOfEnvelope(options.detectors, envelope, options.docs),
    provider: () => options.adapter.provider(),
    modelId: () => options.adapter.modelId() as string,
  });
}

export type { InvestigationEnvelope as InvestigationResult, InvestigationTraceStep };
