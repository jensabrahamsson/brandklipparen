import type { Probabilities, RiskKind, Signal } from "../types.ts";

const SEVERITY_RANK: Record<string, number> = { low: 0, medium: 1, high: 2 };

// Plain-language reason per known signal id (design review: gauges must
// read without decoding bytecode vocabulary). Unknown ids fall back to the
// title-cased id via plainReason.
export const SIGNAL_PLAIN: Readonly<Record<string, string>> = {
  "owner-blacklist": "The owner can stop you from selling.",
  mintable: "The owner can create new tokens and dilute you.",
  pausable: "The owner can pause trading at will.",
  "fee-on-transfer": "A cut of every sale goes to the owner.",
  "owner-withdraw": "The owner can drain pooled funds.",
  "proxy-upgrade": "The owner can swap the contract logic later.",
  "honeypot-transfer": "Buys succeed but sales are blocked in code.",
};

export function plainReason(signal: Signal): string {
  return SIGNAL_PLAIN[signal.id] ?? signalTitle(signal);
}

export function emptyGaugeReason(): string {
  return "Base rate for new tokens; no specific pattern found.";
}

// Impact order (design review: the "sorted by impact" claim must hold):
// signals that raise risk first, then lowers; high severity before low.
export function sortByImpact(signals: readonly Signal[]): Signal[] {
  const directionRank = (signal: Signal): number => ((signal.direction ?? "raises") === "raises" ? 0 : 1);
  return [...signals].sort((a, b) => {
    const direction = directionRank(a) - directionRank(b);
    if (direction !== 0) {
      return direction;
    }
    return rank(b) - rank(a);
  });
}

// One line under the combined ring relating the score to the strongest
// single-risk probability, so the ring and gauges read as one story.
export function combinedScoreLine(score: number, probabilities: Probabilities): string {
  let topLabel = "Rug pull";
  let topValue = -1;
  for (const [risk, label] of [["rug-pull", "Rug pull"], ["honeypot", "Honeypot"], ["bot-pump", "Bot-pump"]] as const) {
    const value = probabilities[risk];
    if (value > topValue) {
      topValue = value;
      topLabel = label;
    }
  }
  return `Combined ${score} follows the strongest single risk: ${topLabel} at ${Math.round(topValue * 100)}%.`;
}

export function strongestSignal(
  signals: readonly Signal[],
  risk: RiskKind,
): Signal | undefined {
  let best: Signal | undefined;
  for (const signal of signals) {
    if (signal.risk !== risk) {
      continue;
    }
    if (best === undefined || rank(signal) > rank(best)) {
      best = signal;
    }
  }
  return best;
}

function rank(signal: Signal): number {
  return SEVERITY_RANK[signal.severity ?? "medium"] ?? 1;
}

export function signalTitle(signal: Signal): string {
  if (signal.kind === "clone-match") {
    const group = signal.group ?? "known template";
    return `Matches ${group} (${Math.round((signal.similarity ?? 0) * 100)}% similar)`;
  }
  if (signal.kind === "hard-to-analyze") {
    return `Hard to analyze: ${signal.cause ?? "decompilation limit reached"}`;
  }
  return signal.id
    .split(/[-_]/g)
    .map((part) => (part.length === 0 ? part : (part[0]?.toUpperCase() ?? "") + part.slice(1)))
    .join(" ");
}
