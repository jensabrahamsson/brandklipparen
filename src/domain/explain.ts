// Template-based deterministic explanations (K-301, K-302, K-303, K-304).
// Pure domain module: rendering is a pure function of the input signals,
// the template version and the observation context. The same triple gives
// bit-identical text on every run (K-102, A-32). Templates are fixed plain
// English frames keyed by signal catalogue id (templateCatalogueId); every
// claim links to the signal it renders and carries that signal's evidence
// pointers as quoted data. Untrusted contract strings (decompiled snippet
// text) are concatenated through JSON quoting and never interpreted as
// template syntax, so hostile text stays data (K-308). The module carries no
// thresholds, weights or limits: risk, direction, severity and cause travel
// as closed vocabulary words from the signals, and every number in the text
// is evidence data (selector, offset, block, value, similarity, count).
// The supported template sets are 1.0.0 and 1.1.0; rendering with any
// other version yields the typed unknown-template-version error, so output
// always records the version it was rendered with. Signals without their own
// temporality (clone-match, hard-to-analyze) receive the caller-supplied
// observation context; the core invents no authority and no measurements.
import { err, ok } from "./result.ts";
import type { Result } from "./result.ts";
import type { CanonicalValue } from "./serialize.ts";
import { sortEvidence } from "./evidence.ts";
import type { NonEmpty, Evidence as EvidenceType } from "./evidence.ts";
import { tableSignatureFor } from "./evmNames.ts";
import type {
  HardToAnalyzeCause,
  RiskType,
  Signal,
  Temporality,
} from "./signals.ts";
import type {
  SignalId as SignalIdType,
  TemplateVersion as TemplateVersionType,
} from "./types.ts";

export type Claim = {
  readonly text: string;
  readonly signalLinks: NonEmpty<SignalIdType>;
  readonly temporality: Temporality;
};

export type Explanation = {
  readonly kind: "template";
  readonly claims: readonly Claim[];
  readonly templateVersion: TemplateVersionType;
};

export type ExplainError = {
  readonly kind: "unknown-template-version";
  readonly message: string;
  readonly templateVersion: string;
};

// Template sets (K-301, P-1). New wording ships as a new version beside
// the old one; the version in the output keeps text reproducible. 1.0.0
// renders one claim per signal with the original risk-verb sentences.
// 1.1.0 renders one sentence per finding origin (capability key or
// owner-control feature), merges claims that share a signal id, an
// origin and a temporality, and stays silent on storage-write. Both versions are
// display-only: neither touches score, probabilities or the signal list.
export const SUPPORTED_TEMPLATE_VERSION: TemplateVersionType =
  "1.1.0" as TemplateVersionType;

export const TEMPLATE_VERSION_1_1_0: TemplateVersionType =
  "1.1.0" as TemplateVersionType;

const SUPPORTED_TEMPLATE_VERSIONS: readonly string[] = Object.freeze([
  "1.0.0",
  "1.1.0",
]);

// Origin of one signal (P-1): who reported the pattern and under which
// key. The key is the capability key (`call`, `storage-write`,
// `delegatecall`, `selfdestruct`) or the owner-control `feature`
// (`mint`, `blacklist`, `pause`, `transfer-fee`, `transfer-limits`,
// `sell-block`, `transfer-hooks`, `proxy-upgrade`, `ownership`,
// `owner-slot`, `renounce`). The application builds this map by matching
// finding evidence to signal evidence and passes it as data; the template
// never invents an origin.
export type ExplanationOrigin = {
  readonly pluginId: string;
  readonly key: string;
};

// Catalogue id per signal: one template frame per capability risk, per
// clone-match risk and per hard-to-analyze cause. The table over this closed
// set is total, so a catalogue miss is unrepresentable; an unknown template
// version is the typed error instead.
export type TemplateCatalogueId =
  | `capability:${RiskType}`
  | `clone-match:${RiskType}`
  | `hard-to-analyze:${HardToAnalyzeCause}`;

export function templateCatalogueId(signal: Signal): TemplateCatalogueId {
  switch (signal.kind) {
    case "capability":
      return `capability:${signal.risk}`;
    case "clone-match":
      return `clone-match:${signal.risk}`;
    case "hard-to-analyze":
      return `hard-to-analyze:${signal.cause}`;
  }
}

// Capability effects in active plain English per risk type (K-303). These are
// fixed template words describing capability, never intent: no statement
// about why anyone wrote the code or what anyone plans.
const CAPABILITY_EFFECT: Readonly<Record<RiskType, string>> = Object.freeze({
  "rug-pull": "move funds out of the contract",
  honeypot: "block a withdrawal, so funds stay in",
  "bot-pump": "favor one trade over another",
});

// One honest sentence per finding origin (P-1). Each sentence states only
// the power the finding proves, never a risk verb the code does not show:
// a plain CALL is not a blocked withdrawal and a plain SSTORE is not a
// rigged trade. `storage-write` is deliberately absent: every token writes
// storage, so it stays a signal for the score but renders no claim.
const ORIGIN_SENTENCE: Readonly<Record<string, string>> = Object.freeze({
  blacklist: "The owner can stop chosen wallets from sending tokens.",
  pause: "A privileged account can freeze transfers.",
  mint: "The owner can create new tokens.",
  "transfer-fee": "The owner can change the fee taken on each transfer.",
  "transfer-limits": "The owner can cap how much a wallet may send or hold.",
  "sell-block": "Transfers to the trading pair can be blocked.",
  "transfer-hooks": "Each transfer can call an outside contract the owner set.",
  "proxy-upgrade": "The admin can replace the contract's code.",
  ownership: "An owner account controls the functions below.",
  "owner-slot": "An owner account controls the functions below.",
  renounce: "The owner can give up ownership.",
  selfdestruct: "The contract can destroy itself and redirect funds.",
  delegatecall: "The contract can run foreign code in local storage context.",
});

// First sentence for a call capability (P-1): neutral, no risk verb. The
// function label names where the call sits: the known canonical signature
// from the versioned selector table, else the raw selector. The label is
// display data from evidence and never invents a name.
function callSentence(signal: Signal): string {
  const first = signal.evidence[0];
  const selector = first === undefined ? "0x00000000" : (first.selector as string);
  const known = tableSignatureFor(selector);
  const label = known ?? selector;
  return `The contract can call other contracts or send ETH (in \`${label}\`).`;
}

// Cause leads in active plain English (K-303). Each states what the analysis
// could not do, without blaming any actor.
const HARD_TO_ANALYZE_LEAD: Readonly<Record<HardToAnalyzeCause, string>> = Object.freeze({
  timeout: "The analysis ran out of time before it could read all of the code.",
  "resource-limit": "The analysis ran out of resources before it could read all of the code.",
  "decompiler-error": "The decompiler reported an error, so the analysis could not read all of the code.",
  "obfuscated-structure": "The code structure resists direct reading, so the analysis could not map all of it.",
});

// Holds-now carries value, block and time; can-change carries the proven
// changer (K-303), while can-change-unknown names no account because no
// controlling account is proven. Numbers and addresses render as data.
// Exported so model input builders quote the same sentence the template
// renders (M-02e); the claim text stays the single source of meaning.
export function describeTemporality(temporality: Temporality): string {
  switch (temporality.kind) {
    case "applies-now": {
      const measured = temporality.measuredValue;
      return `Holds now: the stored value is ${measured.value as string}, read at block ${measured.block as number} at time ${measured.at as number}.`;
    }
    case "can-change":
      return `Can change: account ${temporality.changer as string} can activate this later.`;
    case "can-change-unknown":
      return "Can change: the code can activate this later, but no controlling account is proven.";
  }
}

// Evidence pointers as data: selector and byte offset where derivable, the
// decompiled line where present with its text JSON-quoted so hostile content
// stays literal (K-308, K-304). Entries arrive pre-sorted from the signal
// constructors, and that order is kept.
function renderEvidence(evidence: NonEmpty<EvidenceType>): string {
  const parts: string[] = [];
  for (const entry of evidence) {
    const selector = entry.selector as string;
    const snippet =
      entry.snippet === undefined
        ? null
        : `(decompiled line ${entry.snippet.line} reads ${JSON.stringify(entry.snippet.text)})`;
    if (entry.offset !== undefined && snippet !== null) {
      parts.push(`selector ${selector} at byte offset ${entry.offset as number} ${snippet}`);
    } else if (entry.offset !== undefined) {
      parts.push(`selector ${selector} at byte offset ${entry.offset as number}`);
    } else if (snippet !== null) {
      parts.push(`selector ${selector} with no byte offset ${snippet}`);
    } else {
      parts.push(`selector ${selector} with no byte offset`);
    }
  }
  return `Evidence: ${parts.join("; ")}.`;
}

function renderClaimText(signal: Signal, temporality: Temporality): string {
  const marker = describeTemporality(temporality);
  const pointers = renderEvidence(signal.evidence);
  switch (signal.kind) {
    case "capability":
      return (
        `The contract code lets an account ${CAPABILITY_EFFECT[signal.risk]}. ` +
        `This ${signal.direction} the ${signal.risk} risk (severity ${signal.severity}). ` +
        `${marker} ${pointers}`
      );
    case "clone-match": {
      const count = signal.priorCount;
      const tokenWord = count === 1 ? "token" : "tokens";
      return (
        `This code matches the known template group ${JSON.stringify(signal.group as string)} ` +
        `with similarity ${signal.similarity as number}, seen in ${count} earlier ${tokenWord}. ` +
        `This ${signal.direction} the ${signal.risk} risk (severity ${signal.severity}). ` +
        `${marker} ${pointers}`
      );
    }
    case "hard-to-analyze":
      return (
        `${HARD_TO_ANALYZE_LEAD[signal.cause]} ` +
        `The analysis cannot rule out the ${signal.risk} risk. ` +
        `${marker} ${pointers}`
      );
  }
}

// Pure render in stable signal-id order (A-32). Capability claims carry
// the signal's own temporality; clone-match and hard-to-analyze claims
// carry the caller-supplied observation context.
export function renderExplanation(input: {
  readonly signals: readonly Signal[];
  readonly templateVersion: TemplateVersionType;
  readonly observed: Temporality;
  readonly origins?: ReadonlyMap<string, ExplanationOrigin> | undefined;
}): Result<Explanation, ExplainError> {
  const wanted = input.templateVersion as string;
  if (!SUPPORTED_TEMPLATE_VERSIONS.includes(wanted)) {
    return err({
      kind: "unknown-template-version",
      message: `unknown template version: ${wanted}; supported versions are 1.0.0, 1.1.0`,
      templateVersion: wanted,
    });
  }
  const ordered = input.signals.slice();
  ordered.sort((left, right) => {
    const leftId = left.id as string;
    const rightId = right.id as string;
    if (leftId < rightId) {
      return -1;
    }
    if (leftId > rightId) {
      return 1;
    }
    return 0;
  });
  if (wanted === "1.1.0") {
    return ok(
      Object.freeze({
        kind: "template",
        claims: Object.freeze(renderClaims110(ordered, input.observed, input.origins)),
        templateVersion: input.templateVersion,
      }),
    );
  }
  const claims: Claim[] = [];
  for (const signal of ordered) {
    const temporality = signal.kind === "capability" ? signal.temporality : input.observed;
    claims.push(
      Object.freeze({
        text: renderClaimText(signal, temporality),
        signalLinks: Object.freeze([signal.id]) as NonEmpty<SignalIdType>,
        temporality,
      }),
    );
  }
  return ok(
    Object.freeze({
      kind: "template",
      claims: Object.freeze(claims),
      templateVersion: input.templateVersion,
    }),
  );
}

// Origin entry key for one signal (P-2 follow-up 2): the signal id plus
// the signal's canonical evidence key. A signal id covers the code hash
// and the first evidence selector, so signals with different evidence
// can share one id; an id-keyed map keeps only the first origin and a
// gated mint signal would take the ownership origin. Keying entries per
// signal lets each origin keep its own claim and its own temporality
// text. The application files entries under this key; maps keyed by bare
// signal id still resolve through the id fallback in `originOf` below.
// Exported so the application files the same key the template looks up;
// the claim text stays the single source of meaning.
export function originEntryKey(signal: Signal): string {
  const parts = signal.evidence.map(
    (entry) => `${entry.selector as string}:${entry.offset === undefined ? "none" : String(entry.offset as number)}`,
  );
  parts.sort();
  return `${signal.id as string}|${parts.join(",")}`;
}

// Per-signal origin lookup: the entry filed for this signal's evidence,
// else the entry filed for its bare signal id (callers without per-signal
// entries keep their single origin for every signal sharing the id).
function originOf(
  signal: Signal,
  origins: ReadonlyMap<string, ExplanationOrigin> | undefined,
): ExplanationOrigin | undefined {
  if (origins === undefined) {
    return undefined;
  }
  const direct = origins.get(originEntryKey(signal));
  if (direct !== undefined) {
    return direct;
  }
  return origins.get(signal.id as string);
}

// Temporality part of the 1.1.0 group key: signals that share an id and
// an origin but carry different temporalities (a can-change gated mint
// beside an applies-now owner slot) keep one claim each, so each origin
// keeps its own temporality text. Exported so tests name the same
// grouping the renderer applies.
export function temporalityKeyOf(temporality: Temporality): string {
  switch (temporality.kind) {
    case "applies-now": {
      const measured = temporality.measuredValue;
      return `applies-now:${measured.value as string}|${measured.slot as string}|${measured.block as number}|${measured.at as number}`;
    }
    case "can-change":
      return `can-change:${(temporality.changer as string).toLowerCase()}`;
    case "can-change-unknown":
      return "can-change-unknown";
  }
}

// Group key for 1.1.0 merging (P-1, P-2 follow-up 2): claims merge only
// when they resolve to the same signal id, the same origin and the same
// temporality. Capability signals without a recorded origin fall back to
// their risk frame, so distinct risks sharing one id keep distinct
// claims; non-capability signals carry the caller-supplied observation
// context, so they merge exactly as before.
function groupKeyOf(
  signal: Signal,
  origins: ReadonlyMap<string, ExplanationOrigin> | undefined,
  observed: Temporality,
): string {
  const origin = originOf(signal, origins);
  const frame = origin !== undefined ? `origin:${origin.key}` : templateCatalogueId(signal);
  const temporality = signal.kind === "capability" ? signal.temporality : observed;
  return `${signal.id as string}|${frame}|${temporalityKeyOf(temporality)}`;
}

// Deduplicated merge of grouped evidence in canonical order (A-32).
// Entries carry untrusted snippet text, so dedupe compares the quoted
// fields, never object identity.
function mergeEvidence(signals: readonly Signal[]): NonEmpty<EvidenceType> | null {
  const seen = new Set<string>();
  const merged: EvidenceType[] = [];
  for (const signal of signals) {
    for (const entry of signal.evidence) {
      const snippet = entry.snippet;
      const key = JSON.stringify({
        selector: entry.selector as string,
        offset: (entry.offset as number | undefined) ?? null,
        line: snippet === undefined ? null : snippet.line,
        text: snippet === undefined ? null : snippet.text,
      });
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      merged.push(entry);
    }
  }
  const sorted = sortEvidence(merged);
  const first = sorted[0];
  if (first === undefined) {
    return null;
  }
  return Object.freeze([first, ...sorted.slice(1)]) as NonEmpty<EvidenceType>;
}

// First sentence for a 1.1.0 capability claim (P-1): the origin sentence
// when the signal carries a recorded origin, else the legacy risk frame
// so callers without origins keep a meaningful sentence. A null return
// means the signal renders no claim (`storage-write`).
function firstSentenceOf(
  signal: Extract<Signal, { readonly kind: "capability" }>,
  origin: ExplanationOrigin | undefined,
): string | null {
  if (origin !== undefined) {
    if (origin.key === "call") {
      return callSentence(signal);
    }
    if (origin.key === "storage-write") {
      return null;
    }
    const sentence = ORIGIN_SENTENCE[origin.key];
    if (sentence !== undefined) {
      return sentence;
    }
  }
  return `The contract code lets an account ${CAPABILITY_EFFECT[signal.risk]}.`;
}

function renderClaimText110(
  representative: Signal,
  firstSentence: string,
  evidence: NonEmpty<EvidenceType>,
  temporality: Temporality,
): string {
  const marker = describeTemporality(temporality);
  const pointers = renderEvidence(evidence);
  switch (representative.kind) {
    case "capability":
      return (
        `${firstSentence} ` +
        `This ${representative.direction} the ${representative.risk} risk (severity ${representative.severity}). ` +
        `${marker} ${pointers}`
      );
    case "clone-match": {
      const count = representative.priorCount;
      const tokenWord = count === 1 ? "token" : "tokens";
      return (
        `This code matches the known template group ${JSON.stringify(representative.group as string)} ` +
        `with similarity ${representative.similarity as number}, seen in ${count} earlier ${tokenWord}. ` +
        `This ${representative.direction} the ${representative.risk} risk (severity ${representative.severity}). ` +
        `${marker} ${pointers}`
      );
    }
    case "hard-to-analyze":
      return (
        `${HARD_TO_ANALYZE_LEAD[representative.cause]} ` +
        `The analysis cannot rule out the ${representative.risk} risk. ` +
        `${marker} ${pointers}`
      );
  }
}

// One claim per (signal id, origin, temporality) group in stable id order
// (P-1, P-2 follow-up 2). The merged claim lists every evidence pointer
// once; its risk sentence and temporality come from the first signal of
// the group in id order, and the input signals are never mutated.
function renderClaims110(
  ordered: readonly Signal[],
  observed: Temporality,
  origins: ReadonlyMap<string, ExplanationOrigin> | undefined,
): Claim[] {
  const groups = new Map<string, Signal[]>();
  for (const signal of ordered) {
    const key = groupKeyOf(signal, origins, observed);
    const known = groups.get(key);
    if (known === undefined) {
      groups.set(key, [signal]);
    } else {
      known.push(signal);
    }
  }
  const claims: Claim[] = [];
  for (const group of groups.values()) {
    const representative = group[0];
    if (representative === undefined) {
      continue;
    }
    if (representative.kind === "capability") {
      const firstSentence = firstSentenceOf(representative, originOf(representative, origins));
      const evidence = mergeEvidence(group);
      if (firstSentence === null || evidence === null) {
        continue;
      }
      const temporality = representative.temporality;
      claims.push(
        Object.freeze({
          text: renderClaimText110(representative, firstSentence, evidence, temporality),
          signalLinks: Object.freeze([representative.id]) as NonEmpty<SignalIdType>,
          temporality,
        }),
      );
      continue;
    }
    const temporality = observed;
    const evidence = mergeEvidence(group);
    if (evidence === null) {
      continue;
    }
    claims.push(
      Object.freeze({
        text: renderClaimText110(representative, "", evidence, temporality),
        signalLinks: Object.freeze([representative.id]) as NonEmpty<SignalIdType>,
        temporality,
      }),
    );
  }
  return claims;
}

function temporalityToCanonical(temporality: Temporality): CanonicalValue {
  switch (temporality.kind) {
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
    case "can-change":
      return { kind: "can-change", changer: temporality.changer as string };
    case "can-change-unknown":
      return { kind: "can-change-unknown" };
  }
}

// Canonical mapping of an explanation for golden comparison and hashing
// (A-32 point 5): fixed shape, key order normalised by canonicalSerialize.
export function explanationToCanonical(explanation: Explanation): CanonicalValue {
  return {
    kind: explanation.kind,
    templateVersion: explanation.templateVersion as string,
    claims: explanation.claims.map((claim) => ({
      text: claim.text,
      signalLinks: claim.signalLinks.map((link) => link as string),
      temporality: temporalityToCanonical(claim.temporality),
    })),
  };
}
