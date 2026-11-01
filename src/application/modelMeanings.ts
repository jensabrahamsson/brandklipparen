// Envelope meanings for model input (M-02e). Application wiring over the
// frozen assessment envelope: every signal quotes its rendered template
// claim, and every plugin finding quotes its title, so the model receives
// each id with its stated meaning instead of a bare id. A listed finding
// id means that detector FOUND the pattern. Scores, signals, evidence
// and finding content pass through untouched; the output only feeds the
// model input builders.
import {
  capMeaningsForModel,
  claimBySignalId,
  meaningForEvidenceFinding,
  meaningForSignal,
} from "../domain/modelMeanings.ts";
import type { FindingMeaning } from "../domain/modelMeanings.ts";
import type { CantTellQuestion } from "../domain/cantTell.ts";
import type { Temporality } from "../domain/signals.ts";
import type { AssessmentEnvelope } from "./analyzeToken.ts";

// Observation fallback for signals whose template claim is missing (only
// when the envelope carries no matching claim): names no controlling
// account, never invents one.
const UNKNOWN_OBSERVED: Temporality = Object.freeze({ kind: "can-change-unknown" });

// Citable coverage ids for the explain prompt (explain-3). They name
// what WAS checked even when nothing was found: one `cant-tell:<q>`
// per open question, one `check:<detector>:not-found` per detector that
// checked and found nothing, one `check:<detector>:could-not-check`
// per detector that could not read, and one `analysis:summary` for the
// coverage facts. Scores, signals, evidence and finding text never
// change: these ids only widen the citation universe beside the
// collected signal ids.
export const ANALYSIS_SUMMARY_ID = "analysis:summary";

export function cantTellCoverageId(question: CantTellQuestion): string {
  return `cant-tell:${question as string}`;
}

export function detectorCheckCoverageId(
  pluginId: string,
  outcome: "not-found" | "could-not-check",
): string {
  return `check:${pluginId}:${outcome}`;
}

export function explainCoverageIds(envelope: AssessmentEnvelope): readonly string[] {
  const ids: string[] = [];
  for (const item of envelope.cantTell) {
    ids.push(cantTellCoverageId(item.question));
  }
  for (const entry of envelope.pluginResults) {
    if (entry.outcome === "ok") {
      if (entry.findings.length === 0) {
        ids.push(detectorCheckCoverageId(entry.pluginId as string, "not-found"));
      }
    } else {
      ids.push(detectorCheckCoverageId(entry.pluginId as string, "could-not-check"));
    }
  }
  ids.push(ANALYSIS_SUMMARY_ID);
  return Object.freeze(ids);
}

// Meanings beside the coverage ids: each entry states what was checked
// (or could not be read) so the model never has to guess. The summary
// quotes only envelope facts: scored signal count, unreadable detector
// count, whether deepening decompiled the bytecode (a snippet beside
// any signal), the proxy kind and the open-question count.
export function explainCoverageMeanings(envelope: AssessmentEnvelope): readonly FindingMeaning[] {
  const meanings: FindingMeaning[] = [];
  for (const item of envelope.cantTell) {
    meanings.push(
      Object.freeze({
        id: cantTellCoverageId(item.question),
        pluginId: "analysis",
        kind: "cant-tell",
        severity: null,
        direction: null,
        meaning: `Bytecode analysis cannot tell ${item.question as string}; ${item.dataSource as string} would settle it.`,
        temporality: "unknown",
        selectors: Object.freeze([]),
      }),
    );
  }
  for (const entry of envelope.pluginResults) {
    if (entry.outcome === "ok") {
      if (entry.findings.length === 0) {
        meanings.push(
          Object.freeze({
            id: detectorCheckCoverageId(entry.pluginId as string, "not-found"),
            pluginId: entry.pluginId as string,
            kind: "detector-check",
            severity: null,
            direction: null,
            meaning: `Detector ${entry.pluginId as string} checked the bytecode and found no pattern.`,
            temporality: "unknown",
            selectors: Object.freeze([]),
          }),
        );
      }
    } else {
      meanings.push(
        Object.freeze({
          id: detectorCheckCoverageId(entry.pluginId as string, "could-not-check"),
          pluginId: entry.pluginId as string,
          kind: "detector-check",
          severity: null,
          direction: null,
          meaning: `Detector ${entry.pluginId as string} could not read the bytecode (${entry.outcome}), so its pattern is unknown.`,
          temporality: "unknown",
          selectors: Object.freeze([]),
        }),
      );
    }
  }
  const unreadable = envelope.pluginResults.filter((entry) => entry.outcome !== "ok").length;
  const decompiled = envelope.signals.some((signal) =>
    signal.evidence.some((item) => item.snippet !== undefined),
  );
  meanings.push(
    Object.freeze({
      id: ANALYSIS_SUMMARY_ID,
      pluginId: "analysis",
      kind: "analysis-summary",
      severity: null,
      direction: null,
      meaning:
        `Checked ${envelope.pluginResults.length} detectors: ${envelope.signals.length} scored signals found, ` +
        `${unreadable} detectors could not be read. Bytecode ${decompiled ? "decompiled" : "not decompiled"}; ` +
        `proxy: ${envelope.proxy.kind}; ${envelope.cantTell.length} questions remain open.`,
      temporality: "unknown",
      selectors: Object.freeze([]),
    }),
  );
  return Object.freeze(meanings);
}

export function envelopeMeanings(envelope: AssessmentEnvelope): readonly FindingMeaning[] {
  const byId = claimBySignalId(envelope.explanation.claims);
  const meanings: FindingMeaning[] = envelope.signals.map((signal) =>
    meaningForSignal(signal, byId.get(`signal:${signal.id as string}`) ?? null, UNKNOWN_OBSERVED),
  );
  for (const entry of envelope.pluginResults) {
    if (entry.outcome !== "ok") {
      continue;
    }
    for (const finding of entry.findings) {
      meanings.push(
        meaningForEvidenceFinding({
          id: finding.id,
          pluginId: finding.pluginId as string,
          title: finding.title,
          selectors: finding.evidence.map((item) => item.selector as string),
        }),
      );
    }
  }
  return capMeaningsForModel(meanings);
}
