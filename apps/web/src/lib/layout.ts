// Risk-adaptive deterministic layout (S-060, K-034, P-19). A pure
// section-ordering function over the frozen analysis: the score summary
// stays pinned first in every band (the sticky summary strip keys off the
// ring's viewport visibility), and high risk pulls the most severe
// evidence-bearing sections directly under it. The middle and low bands
// keep the standard order. The same inputs always yield the same plan;
// reordering never hides content — every section stays present and
// reachable in every band. Only order changes; scores, evidence and
// finding text never move.
import { riskWord } from "./risk.ts";

// Closed section whitelist for the overview page (P-22 family): the
// deterministic plan emits these ids, and the renderer maps each one to
// its card. Personalization (P-25, P-27) reuses this whitelist and never
// invents a section.
export const SECTION_ORDER_STANDARD: readonly string[] = Object.freeze([
  "score",
  "explanation",
  "signals",
  "plugin-findings",
  "cant-tell",
]);

export type LayoutInput = {
  readonly score: number;
  readonly signalCount: number;
  readonly severeSignalCount: number;
  readonly pluginFindingCount: number;
  readonly cantTellCount: number;
};

// Pure layout plan: order only, no content. Counts are accepted for the
// future severity tie-break and asserted unused today would be dead code;
// they document the frozen facts the plan reads.
export function planLayout(input: LayoutInput): readonly string[] {
  void input.signalCount;
  void input.severeSignalCount;
  void input.pluginFindingCount;
  void input.cantTellCount;
  const clamped = Number.isFinite(input.score) ? Math.min(100, Math.max(0, input.score)) : 0;
  const word = riskWord(clamped);
  if (word === "High") {
    return Object.freeze(["score", "signals", "plugin-findings", "explanation", "cant-tell"]);
  }
  return SECTION_ORDER_STANDARD;
}
