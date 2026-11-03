import type { Probabilities, RiskKind, Signal } from "../types.ts";

const SEVERITY_RANK: Record<string, number> = { low: 0, medium: 1, high: 2 };

// Human title per known capability id (S-116: signals read as what they
// mean, never as hex). Unknown ids fall back to a risk-and-severity label
// via signalTitle, so no title ever carries raw hex.
export const CAPABILITY_TITLE: Readonly<Record<string, string>> = {
  "owner-blacklist": "Owner can block transfers",
  mintable: "Owner can mint new tokens",
  pausable: "Owner can pause trading",
  "fee-on-transfer": "Sales carry an owner fee",
  "owner-withdraw": "Owner can withdraw funds",
  "proxy-upgrade": "Owner can swap the code",
  "honeypot-transfer": "Buys work, sells may fail",
};

// Plain-language reason per known signal id (design review: gauges must
// read without decoding bytecode vocabulary). Unknown ids fall back to the
// human title via plainReason, so gauge reasons never carry raw hex.
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

export function emptyGaugeReason(hasSignals = false): string {
  // The usual-rate wording belongs only to a truly quiet analysis and
  // renders on one gauge only (the TokenPage call site gates the rest).
  // When other risks fired but this one did not, the gauge says so
  // without invoking the population base rate.
  if (hasSignals) {
    return "None found.";
  }
  return "Typical for new tokens.";
}

// Owner-powers strip summary (UI v2 §1.1, D9): counts per detector
// state, never a "·" row (the meta-separator scan owns middots). The
// extended count always carries its "not in score" label, and the
// no-scored-pattern form names the extended count so a quiet signal
// list never contradicts the extended finding below it.
export type PowersSummaryCounts = {
  readonly found: number;
  readonly extended: number;
  readonly cantTell: number;
  // SCORE-4: floor facts count inside `found`; `floor` names how many
  // of them set the minimum score. Renounced-lifted facts count in
  // neither `found` nor `extended`.
  readonly floor?: number;
  readonly renounced?: number;
};

export function powersSummaryCopy({ found, extended, cantTell, floor = 0, renounced = 0 }: PowersSummaryCounts): string {
  if (found > 0) {
    const parts = [`${found} found`];
    if (floor > 0) {
      parts.push(`Sets score floor: ${floor}`);
    }
    if (extended > 0) {
      parts.push(`Not yet scored: ${extended}`);
    }
    if (renounced > 0) {
      parts.push(`Owner renounced: ${renounced} lifted`);
    }
    if (cantTell > 0) {
      parts.push(`${cantTell} unreadable`);
    }
    return `${parts.join(". ")}.`;
  }
  if (extended > 0) {
    const noun = extended === 1 ? "owner power" : "owner powers";
    const cant = cantTell > 0 ? ` ${cantTell} unreadable.` : "";
    const ren = renounced > 0 ? ` Owner renounced: ${renounced} lifted.` : "";
    return `${extended} ${noun}, not yet scored.${ren}${cant}`;
  }
  if (renounced > 0) {
    const checks = cantTell === 1 ? "1 check" : `${cantTell} checks`;
    const cant = cantTell > 0 ? ` ${checks} unreadable.` : "";
    return `Owner renounced. ${renounced} ${renounced === 1 ? "power" : "powers"} lifted.${cant}`;
  }
  if (cantTell > 0) {
    const checks = cantTell === 1 ? "1 check" : `${cantTell} checks`;
    return `${checks} unreadable.`;
  }
  return "No owner powers found.";
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
  return `${topLabel} ${Math.round(topValue * 100)}% is the top risk.`;
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

export function riskLabel(risk: RiskKind): string {
  if (risk === "rug-pull") {
    return "Rug pull";
  }
  if (risk === "honeypot") {
    return "Honeypot";
  }
  return "Bot-pump";
}

const HEX_ID_PATTERN = /0x[0-9a-f]{4,}/i;

// Stable unique key per rendered signal position (S-116). The REST layer
// may repeat signal ids within one response, so the UI never keys React
// lists, DOM ids or open state by signal id.
export function signalKey(signal: Signal, index: number): string {
  return `${index}-${signal.kind}-${signal.risk}`;
}

// Unknown ids read as a plain risk title with no severity paren: the
// row tag already carries the severity, so the title never repeats it
// and never matches "pattern (" (round-3 review D-11).
function riskPatternTitle(signal: Signal): string {
  return `${riskLabel(signal.risk)} risk`;
}

export function signalTitle(signal: Signal): string {
  if (signal.kind === "clone-match") {
    const group = signal.group ?? "known template";
    return `Matches ${group} (${Math.round((signal.similarity ?? 0) * 100)}% similar)`;
  }
  if (signal.kind === "hard-to-analyze") {
    return signal.cause === "obfuscated-structure" ? "Obfuscated code" : "Code not fully read";
  }
  const mapped = CAPABILITY_TITLE[signal.id];
  if (mapped !== undefined) {
    return mapped;
  }
  if (HEX_ID_PATTERN.test(signal.id)) {
    return riskPatternTitle(signal);
  }
  const titled = signal.id
    .split(/[-_]/g)
    .map((part) => (part.length === 0 ? part : (part[0]?.toUpperCase() ?? "") + part.slice(1)))
    .join(" ");
  return HEX_ID_PATTERN.test(titled) ? riskPatternTitle(signal) : titled;
}
