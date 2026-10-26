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
// The single supported template set is 1.0.0; rendering with any other
// version yields the typed unknown-template-version error, so output always
// records the version it was rendered with. Signals without their own
// temporality (clone-match, hard-to-analyze) receive the caller-supplied
// observation context; the core invents no authority and no measurements.
import { err, ok } from "./result.ts";
import type { Result } from "./result.ts";
import type { CanonicalValue } from "./serialize.ts";
import type { NonEmpty, Evidence as EvidenceType } from "./evidence.ts";
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

// The single supported template set (K-301). New wording ships as a new
// version beside this one; the version in the output keeps text reproducible.
export const SUPPORTED_TEMPLATE_VERSION: TemplateVersionType =
  "1.0.0" as TemplateVersionType;

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

// Cause leads in active plain English (K-303). Each states what the analysis
// could not do, without blaming any actor.
const HARD_TO_ANALYZE_LEAD: Readonly<Record<HardToAnalyzeCause, string>> = Object.freeze({
  timeout: "The analysis ran out of time before it could read all of the code.",
  "resource-limit": "The analysis ran out of resources before it could read all of the code.",
  "decompiler-error": "The decompiler reported an error, so the analysis could not read all of the code.",
  "obfuscated-structure": "The code structure resists direct reading, so the analysis could not map all of it.",
});

// Holds-now carries value, block and time; can-change carries the authorised
// changer (K-303). Numbers and addresses render as data.
function renderMarker(temporality: Temporality): string {
  switch (temporality.kind) {
    case "applies-now": {
      const measured = temporality.measuredValue;
      return `Holds now: the stored value is ${measured.value as string}, read at block ${measured.block as number} at time ${measured.at as number}.`;
    }
    case "can-change":
      return `Can change: account ${temporality.changer as string} can activate this later.`;
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
  const marker = renderMarker(temporality);
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

// Pure render of one claim per signal in stable signal-id order (A-32).
// Capability claims carry the signal's own temporality; clone-match and
// hard-to-analyze claims carry the caller-supplied observation context.
export function renderExplanation(input: {
  readonly signals: readonly Signal[];
  readonly templateVersion: TemplateVersionType;
  readonly observed: Temporality;
}): Result<Explanation, ExplainError> {
  const wanted = input.templateVersion as string;
  const supported = SUPPORTED_TEMPLATE_VERSION as string;
  if (wanted !== supported) {
    return err({
      kind: "unknown-template-version",
      message: `unknown template version: ${wanted}; supported version is ${supported}`,
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
