import type { RiskKind, Signal } from "../types.ts";

const SEVERITY_RANK: Record<string, number> = { low: 0, medium: 1, high: 2 };

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
