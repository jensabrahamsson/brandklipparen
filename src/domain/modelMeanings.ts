// Per finding and signal meanings for model input (M-02e). Pure domain
// module: the deterministic analysis already proved every finding and
// signal, and the model evidently received bare ids without their
// meaning, so this module pairs each id with its stated meaning for the
// prompt. It changes nothing scored: plugin ids, kinds, severities,
// directions, template sentences and temporalities are quoted from the
// frozen signals, claims and finding titles, and selector names come
// from the versioned offline table only. Unknown selectors stay the raw
// selector with a null name; the lookup never invents a name.
import { tableSignatureFor } from "./evmNames.ts";
import { describeTemporality } from "./explain.ts";
import type { Claim } from "./explain.ts";
import type { Signal } from "./signals.ts";
import type { Temporality } from "./signals.ts";

// One labelled selector: the raw selector with the known canonical
// signature beside it, or a null name when the table holds no row.
export type MeaningSelector = {
  readonly selector: string;
  readonly name: string | null;
};

// One id with its stated meaning: the plugin that found it, its kind,
// its severity and direction when the signal carries them, the template
// sentence (or finding title) saying what it means, the temporality
// sentence, and the labelled selectors behind it.
export type FindingMeaning = {
  readonly id: string;
  readonly pluginId: string;
  readonly kind: string;
  readonly severity: string | null;
  readonly direction: string | null;
  readonly meaning: string;
  readonly temporality: string;
  readonly selectors: readonly MeaningSelector[];
};

// Model input budget for meanings (M-02e): at most this many entries
// travel, each meaning and temporality sentence truncated to the char
// cap, each entry carrying at most this many labelled selectors. The
// evidence ids always travel whole beside them, so citations still work
// when a meaning is trimmed away.
export const MAX_MODEL_MEANINGS = 32;
export const MAX_MEANING_CHARS = 300;
export const MAX_MEANING_SELECTORS = 8;

// Decompiler display records sort after every other finding: they name
// reconstructed functions, not risk patterns, so they trim first.
const DECOMPILER_PLUGIN_ID = "dev.brandklipparen.decompiler";

// Coverage entries state what the analysis could NOT prove (limits of the
// deterministic pass, open can't-tell questions, an incomplete
// decompilation), never a found pattern. They sort after every finding,
// including decompiler display records, so trimming drops the limits
// first and never the proved patterns.
const COVERAGE_KIND = "coverage";

function labelSelector(selector: string): MeaningSelector {
  return Object.freeze({ selector, name: tableSignatureFor(selector) });
}

function labelSelectors(selectors: readonly string[]): readonly MeaningSelector[] {
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const selector of selectors) {
    if (!seen.has(selector)) {
      seen.add(selector);
      ordered.push(selector);
    }
  }
  ordered.sort();
  return Object.freeze(ordered.map(labelSelector));
}

function truncate(text: string): string {
  return text.length > MAX_MEANING_CHARS ? text.slice(0, MAX_MEANING_CHARS) : text;
}

// Meaning for one signal, quoting the rendered template claim when the
// caller hands it over (the claim text is the sentence saying what the
// signal means, and the claim temporality is the observed context the
// template rendered with). Source plugin names the detector behind the
// finding; structural detection without one reports `structural`.
export function meaningForSignal(
  signal: Signal,
  claim: Claim | null,
  observed: Temporality,
): FindingMeaning {
  const temporality = signal.kind === "capability" ? signal.temporality : (claim?.temporality ?? observed);
  const severity = signal.kind === "hard-to-analyze" ? null : signal.severity;
  const direction = signal.kind === "hard-to-analyze" ? null : signal.direction;
  const pluginId = signal.kind === "capability" && signal.sourcePlugin !== undefined ? signal.sourcePlugin : "structural";
  const selectors = signal.evidence.map((entry) => entry.selector as string);
  return Object.freeze({
    id: `signal:${signal.id as string}`,
    pluginId,
    kind: signal.kind,
    severity,
    direction,
    meaning: claim?.text ?? `Signal ${signal.id as string} of kind ${signal.kind}.`,
    temporality: describeTemporality(temporality),
    selectors: labelSelectors(selectors),
  });
}

// Claim per signal id from the rendered explanation: the claim whose
// signal links name the signal carries its template sentence.
export function claimBySignalId(claims: readonly Claim[]): ReadonlyMap<string, Claim> {
  const byId = new Map<string, Claim>();
  for (const claim of claims) {
    for (const link of claim.signalLinks) {
      const raw = (link as string).replace(/^signal:/, "");
      for (const key of [`signal:${raw}`, raw]) {
        if (!byId.has(key)) {
          byId.set(key, claim);
        }
      }
    }
  }
  return byId;
}

// Meaning for one plugin finding that stands beside the signals: the
// finding title is its stated meaning, quoted verbatim. A listed
// finding id means the detector FOUND the pattern; this entry carries
// the title so the model never has to guess what the id means.
export function meaningForEvidenceFinding(input: {
  readonly id: string;
  readonly pluginId: string;
  readonly title: string;
  readonly selectors: readonly string[];
}): FindingMeaning {
  return Object.freeze({
    id: input.id,
    pluginId: input.pluginId,
    kind: "finding",
    severity: null,
    direction: null,
    meaning: input.title,
    temporality: "unknown",
    selectors: labelSelectors(input.selectors),
  });
}

function severityRank(severity: string | null): number {
  if (severity === "high") {
    return 0;
  }
  if (severity === "medium") {
    return 1;
  }
  if (severity === "low") {
    return 2;
  }
  return 3;
}

function kindRank(meaning: FindingMeaning): number {
  if (meaning.kind === COVERAGE_KIND) {
    return 5;
  }
  if (meaning.kind === "finding") {
    return meaning.pluginId === DECOMPILER_PLUGIN_ID ? 4 : 3;
  }
  if (meaning.kind === "capability") {
    return 0;
  }
  if (meaning.kind === "clone-match") {
    return 1;
  }
  return 2;
}

// Meaning for one coverage entry stating an analysis limit: what the
// deterministic pass could not prove, never a found pattern. The text
// must say absence of a finding is not proof of absence, so the entry
// can never read as a clean bill of health. Coverage entries carry no
// selectors and no severity or direction.
export function meaningForCoverage(input: { readonly id: string; readonly meaning: string }): FindingMeaning {
  return Object.freeze({
    id: input.id,
    pluginId: "analysis",
    kind: COVERAGE_KIND,
    severity: null,
    direction: null,
    meaning: input.meaning,
    temporality: "unknown",
    selectors: Object.freeze([]),
  });
}

// Importance order for trimming (M-02e): signals before findings,
// higher severity first, decompiler display records next, coverage
// limits last. Stable, so equal ranks keep their input order and
// trimming drops the least important entries first.
export function orderMeaningsForModel(meanings: readonly FindingMeaning[]): readonly FindingMeaning[] {
  const copy = meanings.slice();
  copy.sort((left, right) => {
    const byKind = kindRank(left) - kindRank(right);
    if (byKind !== 0) {
      return byKind;
    }
    const bySeverity = severityRank(left.severity) - severityRank(right.severity);
    if (bySeverity !== 0) {
      return bySeverity;
    }
    if (left.id < right.id) {
      return -1;
    }
    if (left.id > right.id) {
      return 1;
    }
    return 0;
  });
  return Object.freeze(copy);
}

// Bounded meanings for the prompt: ordered, capped, truncated and
// frozen. Evidence ids travel separately and untrimmed, so a trimmed
// meaning never breaks a citation.
export function capMeaningsForModel(meanings: readonly FindingMeaning[]): readonly FindingMeaning[] {
  return Object.freeze(
    orderMeaningsForModel(meanings)
      .slice(0, MAX_MODEL_MEANINGS)
      .map((meaning) =>
        Object.freeze({
          ...meaning,
          meaning: truncate(meaning.meaning),
          temporality: truncate(meaning.temporality),
          selectors: Object.freeze(meaning.selectors.slice(0, MAX_MEANING_SELECTORS)),
        }),
      ),
  );
}
