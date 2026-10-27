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

export type InvestigationServiceOptions = {
  readonly adapter: InvestigationModelPort;
  readonly detectors: DetectorSet;
  readonly docs: Readonly<Record<string, string>>;
  readonly limits: InvestigationLimits;
};

export type InvestigationService = {
  readonly investigateEnvelope: (
    envelope: AssessmentEnvelope,
    ctx: InvestigationCallContext,
    hooks: InvestigateHooks,
  ) => Promise<InvestigationEnvelope>;
  readonly frozenFactsOf: (envelope: AssessmentEnvelope) => FrozenInvestigationFacts;
  readonly catalogueOf: (envelope: AssessmentEnvelope) => InvestigationCatalogue;
  readonly provider: () => string;
  readonly modelId: () => string;
};

export function createInvestigationService(options: InvestigationServiceOptions): InvestigationService {
  return Object.freeze({
    investigateEnvelope: (envelope, ctx, hooks) => {
      const facts = frozenFactsOfEnvelope(envelope);
      const catalogue = catalogueOfEnvelope(options.detectors, envelope, options.docs);
      return investigateToken(options.adapter, catalogue, facts, ctx, options.limits, hooks);
    },
    frozenFactsOf: (envelope) => frozenFactsOfEnvelope(envelope),
    catalogueOf: (envelope) => catalogueOfEnvelope(options.detectors, envelope, options.docs),
    provider: () => options.adapter.provider(),
    modelId: () => options.adapter.modelId() as string,
  });
}

export type { InvestigationEnvelope as InvestigationResult, InvestigationTraceStep };
