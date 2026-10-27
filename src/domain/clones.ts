// Clone matching against known trap templates (K-017, S-014).
// Pure domain module: matching is an exact hash lookup over a frozen
// template table and signal building pairs the hit with evidence from the
// analysed bytecode. No thresholds, weights or learned numbers live here:
// an exact code-hash hit reports similarity 1 by definition, a
// skeleton-hash hit reports the placeholder similarity carried by the
// matched template entry, and the risk mapping arrives as an injected
// parameter whose production values come from the versioned model artifact
// per K-210 and A-20. A miss yields no hit and therefore no clone signal.
import { Evidence } from "./evidence.ts";
import { extractSelectors } from "./selectors.ts";
import { Signal } from "./signals.ts";
import type { Direction, RiskType, Severity, Signal as SignalType } from "./signals.ts";
import { Probability } from "./types.ts";
import type {
  Bytecode as BytecodeType,
  CloneGroupId as CloneGroupIdType,
  CodeHash as CodeHashType,
  Probability as ProbabilityType,
  SkeletonHash as SkeletonHashType,
} from "./types.ts";

// Risk mapping for a clone-match signal. The values steer scoring, so they
// belong to the versioned model artifact per K-210 and A-20; tests carry
// placeholders and production passes the artifact mapping.
export type CloneMapping = {
  readonly risk: RiskType;
  readonly direction: Direction;
  readonly severity: Severity;
};

// One parsed template entry: the group id and prior count travel onto the
// signal as mandatory evidence, the hashes steer matching, and the
// placeholder similarity is reported on skeleton-hash hits. Template tables
// arrive frozen from the adapter boundary; this module takes validity as
// given and only reads.
export type CloneTemplate = {
  readonly group: CloneGroupIdType;
  readonly codeHash: CodeHashType;
  readonly skeletonHash: SkeletonHashType;
  readonly priorCount: number;
  readonly skeletonSimilarity: ProbabilityType;
};

// One template hit: the similarity share beside the mandatory group id and
// the number of earlier tokens in the group.
export type CloneHit = {
  readonly similarity: ProbabilityType;
  readonly group: CloneGroupIdType;
  readonly priorCount: number;
};

// Exact lookup over the template table. Templates scan in group order, so
// equal tables give the same hit on every run and platform (A-32). A code
// hash hit reports similarity 1; a skeleton hash hit reports the template
// placeholder similarity. Unknown hashes yield null, so the caller adds no
// clone signal on a miss.
export function matchCloneIndex(input: {
  readonly codeHash: CodeHashType;
  readonly skeletonHash: SkeletonHashType;
  readonly templates: readonly CloneTemplate[];
}): CloneHit | null {
  const ordered = input.templates.slice();
  ordered.sort((left, right) => {
    const leftGroup = left.group as string;
    const rightGroup = right.group as string;
    if (leftGroup < rightGroup) {
      return -1;
    }
    if (leftGroup > rightGroup) {
      return 1;
    }
    return 0;
  });
  for (const template of ordered) {
    if ((template.codeHash as string) === (input.codeHash as string)) {
      const similarity = Probability.of(1);
      if (!similarity.ok) {
        continue;
      }
      return Object.freeze({
        similarity: similarity.value,
        group: template.group,
        priorCount: template.priorCount,
      });
    }
  }
  for (const template of ordered) {
    if ((template.skeletonHash as string) === (input.skeletonHash as string)) {
      return Object.freeze({
        similarity: template.skeletonSimilarity,
        group: template.group,
        priorCount: template.priorCount,
      });
    }
  }
  return null;
}

// Clone-match signal for a template hit. The evidence is the first extracted
// selector of the analysed bytecode with its derivable PC offset, so the
// signal links to the analysed code per K-010. Bytecode without selectors
// yields null, since a signal without evidence is unrepresentable per A-13.
export function cloneMatchSignal(input: {
  readonly codeHash: CodeHashType;
  readonly bytecode: BytecodeType;
  readonly hit: CloneHit;
  readonly mapping: CloneMapping;
}): SignalType | null {
  const entries = extractSelectors(input.bytecode);
  const first = entries[0];
  if (first === undefined) {
    return null;
  }
  const evidence =
    first.kind === "paired"
      ? Evidence.create({ selector: first.selector, offset: first.target })
      : Evidence.create({ selector: first.selector });
  if (!evidence.ok) {
    return null;
  }
  const signal = Signal.createCloneMatch({
    codeHash: input.codeHash,
    risk: input.mapping.risk,
    direction: input.mapping.direction,
    severity: input.mapping.severity,
    similarity: input.hit.similarity,
    group: input.hit.group,
    priorCount: input.hit.priorCount,
    evidence: [evidence.value],
  });
  if (!signal.ok) {
    return null;
  }
  return signal.value;
}
