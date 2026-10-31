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
import type { Temporality } from "../domain/signals.ts";
import type { AssessmentEnvelope } from "./analyzeToken.ts";

// Observation fallback for signals whose template claim is missing (only
// when the envelope carries no matching claim): names no controlling
// account, never invents one.
const UNKNOWN_OBSERVED: Temporality = Object.freeze({ kind: "can-change-unknown" });

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
