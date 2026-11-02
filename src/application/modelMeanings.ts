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
  meaningForCoverage,
  meaningForEvidenceFinding,
  meaningForSignal,
} from "../domain/modelMeanings.ts";
import type { FindingMeaning } from "../domain/modelMeanings.ts";
import type { Temporality } from "../domain/signals.ts";
import type { AssessmentEnvelope } from "./analyzeToken.ts";

// Observation fallback for signals whose template claim is missing (only
// when the envelope carries no matching claim): names no controlling
// account, never invents one.
const UNKNOWN_OBSERVED: Temporality = Object.freeze({ kind: "can-change-unknown" });

// Citable coverage ids for the explain prompt (explain-3, C-19). They
// name what WAS checked even when nothing was found, so the model can
// cite the analysis limits honestly: `analysis:summary` first, one
// `cant-tell:<question>` per open question, one
// `check:<detector>:not-found` per detector that checked and found
// nothing, one `check:<detector>:could-not-check` per detector that
// could not read, and `analysis:decompile-incomplete` only when the
// decompiler plugin did not report `ok`. Scores, signals, evidence and
// finding text never change: these ids only widen the citation universe
// beside the collected signal ids.
export const ANALYSIS_SUMMARY_ID = "analysis:summary";
export const ANALYSIS_SUMMARY_COVERAGE_ID = "analysis:summary";
export const DECOMPILE_INCOMPLETE_COVERAGE_ID = "analysis:decompile-incomplete";
const DECOMPILER_PLUGIN_ID = "dev.brandklipparen.decompiler";

function cantTellCoverageId(question: string): string {
  return `cant-tell:${question}`;
}

function detectorCheckCoverageId(
  pluginId: string,
  outcome: "not-found" | "could-not-check",
): string {
  return `check:${pluginId}:${outcome}`;
}

function decompileOutcomeOf(envelope: AssessmentEnvelope): string | null {
  for (const entry of envelope.pluginResults) {
    if ((entry.pluginId as string) === DECOMPILER_PLUGIN_ID) {
      return entry.outcome;
    }
  }
  return null;
}

export function explainCoverageIds(envelope: AssessmentEnvelope): readonly string[] {
  const ids: string[] = [ANALYSIS_SUMMARY_COVERAGE_ID];
  for (const item of envelope.cantTell) {
    ids.push(cantTellCoverageId(item.question as string));
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
  if (decompileOutcomeOf(envelope) !== "ok") {
    ids.push(DECOMPILE_INCOMPLETE_COVERAGE_ID);
  }
  return Object.freeze(ids);
}

function wordsOf(value: string): string {
  return value.replace(/-/g, " ");
}

// Counts behind the summary limit: how many decompiled functions carry a
// proved pattern (distinct selectors in signal and non-decompiler finding
// evidence) out of how many decompiled functions exist. Decompiler
// display records are excluded from the numerator: one exists per
// function by construction, so counting them would always read N of N.
function coverageCounts(envelope: AssessmentEnvelope): { readonly proved: number; readonly total: number } | null {
  let total = 0;
  const proved = new Set<string>();
  for (const entry of envelope.pluginResults) {
    if ((entry.pluginId as string) === DECOMPILER_PLUGIN_ID) {
      if (entry.outcome === "ok") {
        total = entry.findings.length;
      }
      continue;
    }
    if (entry.outcome !== "ok") {
      continue;
    }
    for (const finding of entry.findings) {
      for (const item of finding.evidence) {
        proved.add((item.selector as string).toLowerCase());
      }
    }
  }
  for (const signal of envelope.signals) {
    for (const item of signal.evidence) {
      proved.add((item.selector as string).toLowerCase());
    }
  }
  if (total === 0) {
    return null;
  }
  return { proved: proved.size, total };
}

// Meanings beside the coverage ids: each entry states a limit and says
// absence of a finding is not proof of absence, so no entry can be
// quoted as a clean bill of health. The summary quotes only envelope
// facts: scored signal count, unreadable detector count, whether
// deepening decompiled the bytecode (a snippet beside any signal), the
// proxy kind, the open-question count and, when the decompiler
// reported, how many decompiled functions carry a proved pattern. The
// decompile entry derives from the decompiler plugin outcome, never
// from signal snippets, so a zero-signal envelope still reports an
// incomplete decompilation honestly.
export function explainCoverageMeanings(envelope: AssessmentEnvelope): readonly FindingMeaning[] {
  const meanings: FindingMeaning[] = [];
  for (const item of envelope.cantTell) {
    meanings.push(
      meaningForCoverage({
        id: cantTellCoverageId(item.question as string),
        meaning:
          `Open question the bytecode analysis cannot settle: ${wordsOf(item.question as string)}. ` +
          `Settle it from ${wordsOf(item.dataSource as string)}; do not treat this entry as a safety claim. ` +
          `Absence of a finding is not proof of absence.`,
      }),
    );
  }
  for (const entry of envelope.pluginResults) {
    if (entry.outcome === "ok") {
      if (entry.findings.length === 0) {
        meanings.push(
          meaningForCoverage({
            id: detectorCheckCoverageId(entry.pluginId as string, "not-found"),
            meaning:
              `Detector ${entry.pluginId as string} checked the bytecode and found no pattern. ` +
              `Absence of a finding is not proof that the pattern is absent.`,
          }),
        );
      }
    } else {
      meanings.push(
        meaningForCoverage({
          id: detectorCheckCoverageId(entry.pluginId as string, "could-not-check"),
          meaning:
            `Detector ${entry.pluginId as string} could not read the bytecode (${entry.outcome}), ` +
            `so its pattern is unknown; an absent reading is not proof that the pattern is absent.`,
        }),
      );
    }
  }
  const unreadable = envelope.pluginResults.filter((entry) => entry.outcome !== "ok").length;
  const decompiled = envelope.signals.some((signal) =>
    signal.evidence.some((item) => item.snippet !== undefined),
  );
  const proxyKind = (envelope.proxy as { readonly kind: string } | undefined)?.kind ?? "none";
  const counts = coverageCounts(envelope);
  meanings.push(
    meaningForCoverage({
      id: ANALYSIS_SUMMARY_COVERAGE_ID,
      meaning:
        `Checked ${envelope.pluginResults.length} detectors: ${envelope.signals.length} scored signals found, ` +
        `${unreadable} detectors could not be read. Bytecode ${decompiled ? "decompiled" : "not decompiled"}; ` +
        `proxy: ${proxyKind}; ${envelope.cantTell.length} questions remain open. ` +
        (envelope.scoreFloor === undefined
          ? ""
          : `Score floor: ${envelope.scoreFloor.label} (minimum ${envelope.scoreFloor.minimum}); ` +
            `the served score is at least the minimum because of the proven owner powers named there. `) +
        (counts === null
          ? "The deterministic analysis lists only patterns its detectors proved in the functions they could follow; an absent finding means no proof was found, not proof that the pattern is absent."
          : `Detectors proved a pattern in ${counts.proved} of ${counts.total} decompiled functions; the remaining functions yielded no proof. Absence of a finding is not proof that the pattern is absent.`),
    }),
  );
  const outcome = decompileOutcomeOf(envelope);
  if (outcome !== "ok") {
    meanings.push(
      meaningForCoverage({
        id: DECOMPILE_INCOMPLETE_COVERAGE_ID,
        meaning: `The bytecode was not fully decompiled (decompiler plugin outcome: ${outcome === null ? "missing" : outcome}); function-level reading is incomplete, so an absent finding is not proof of absence.`,
      }),
    );
  }
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

// Explain input meanings (C-19): proved signals and findings first,
// coverage limits after, capped so trimming drops the limits before any
// proved pattern. Evidence ids travel whole beside the meanings, so a
// trimmed coverage meaning never breaks a coverage citation.
export function explainMeanings(envelope: AssessmentEnvelope): readonly FindingMeaning[] {
  return capMeaningsForModel([...envelopeMeanings(envelope), ...explainCoverageMeanings(envelope)]);
}
