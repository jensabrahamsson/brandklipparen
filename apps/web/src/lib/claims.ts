// Claim summaries and signal-to-claim assignment (S-116).
// Template claims arrive as long multi-sentence strings; the UI shows a
// short summary first and keeps the raw detail on demand. Claims map to
// signals by position and risk, never by signal id, so duplicate ids
// cannot misattribute evidence.
import type { ExplanationClaim, Signal } from "../types.ts";

const SUMMARY_MAX = 200;

const CUT_MARKERS: readonly string[] = ["Can change:", "Holds now:", "Evidence:"];

// First visible text of a claim: the sentences before the change marker
// and the evidence list, capped so a summary never fills the screen.
export function claimSummary(text: string): string {
  let summary = text;
  for (const marker of CUT_MARKERS) {
    const at = summary.indexOf(marker);
    if (at >= 0) {
      summary = summary.slice(0, at);
    }
  }
  summary = summary.replace(/\s*\(in\s+`?0x[0-9a-f]+`?\)/gi, "").replace(/0x[0-9a-f]+/gi, "not set").replace(/\s+/g, " ").trim();
  if (summary.length > SUMMARY_MAX) {
    summary = `${summary.slice(0, SUMMARY_MAX - 1).trimEnd()}…`;
  }
  return summary;
}

// One template line per signal in the given signal order. The first pass
// hands each signal the earliest unused claim that names its own risk
// kind; leftovers pair up by position. Duplicate signal ids can never
// collide because ids are never used as the lookup key.
export type EvidenceGroup = {
  readonly selector: string;
  readonly offsets: readonly number[];
  readonly hasNoOffset: boolean;
  readonly line: number | null;
  readonly snippet: string | null;
};

// The controlling account named by a "Can change: account 0x… can
// activate this later." marker, if the claim names one. Addresses travel
// as data and render only through the truncated chip.
export function extractAccount(text: string): string | null {
  const match = /account\s+(0x[0-9a-fA-F]{40})\b/.exec(text);
  return match?.[1] ?? null;
}

// Evidence pointers out of the claim's "Evidence: …" tail (S-120):
// `selector 0x… at byte offset N (decompiled line L reads "…")` or
// `selector 0x… with no byte offset`. Pointers group by selector and
// decompiled line, so one selector renders once with its offset list and
// identical decompiled lines collapse instead of repeating.
const EVIDENCE_PATTERN =
  /selector\s+(0x[0-9a-fA-F]+)\s+(?:at byte offset\s+(\d+)|with no byte offset)(?:\s+\(decompiled line\s+(\d+)\s+reads\s+"((?:[^"\\]|\\.)*)"\))?/g;

type MutableGroup = {
  selector: string;
  offsets: number[];
  hasNoOffset: boolean;
  line: number | null;
  snippet: string | null;
};

export function extractEvidenceGroups(text: string): EvidenceGroup[] {
  const tail = text.indexOf("Evidence:");
  const source = tail >= 0 ? text.slice(tail) : text;
  const byGroup = new Map<string, MutableGroup>();
  const seen = new Set<string>();
  for (const match of source.matchAll(EVIDENCE_PATTERN)) {
    const selector = match[1] as string;
    const offset = match[2] === undefined ? null : Number.parseInt(match[2] as string, 10);
    const line = match[3] === undefined ? null : Number.parseInt(match[3] as string, 10);
    const snippet = match[4] ?? null;
    if (offset !== null && !Number.isSafeInteger(offset)) {
      continue;
    }
    if (line !== null && !Number.isSafeInteger(line)) {
      continue;
    }
    const pointer = `${selector}|${offset === null ? "" : offset}|${line === null ? "" : line}|${snippet ?? ""}`;
    if (seen.has(pointer)) {
      continue;
    }
    seen.add(pointer);
    const groupKey = `${selector}|${line === null ? "" : line}|${snippet ?? ""}`;
    let group = byGroup.get(groupKey);
    if (group === undefined) {
      group = { selector, offsets: [], hasNoOffset: false, line, snippet };
      byGroup.set(groupKey, group);
    }
    if (offset === null) {
      group.hasNoOffset = true;
    } else if (!group.offsets.includes(offset)) {
      group.offsets.push(offset);
    }
  }
  return [...byGroup.values()].map((group) => ({
    selector: group.selector,
    offsets: [...group.offsets],
    hasNoOffset: group.hasNoOffset,
    line: group.line,
    snippet: group.snippet,
  }));
}

// Countable locations for the "Evidence · N locations" disclosure: every
// byte offset plus one for each pointer without an offset.
export function evidenceLocationCount(groups: readonly EvidenceGroup[]): number {
  return groups.reduce((total, group) => total + group.offsets.length + (group.hasNoOffset ? 1 : 0), 0);
}
export function assignTemplateLines(
  signals: readonly Signal[],
  claims: readonly ExplanationClaim[],
): readonly (string | undefined)[] {
  const used = new Array<boolean>(claims.length).fill(false);
  return signals.map((signal) => {
    const needle = signal.risk.toLowerCase();
    let pick = -1;
    for (let index = 0; index < claims.length; index += 1) {
      if (!used[index] && (claims[index] as ExplanationClaim).text.toLowerCase().includes(needle)) {
        pick = index;
        break;
      }
    }
    if (pick < 0) {
      for (let index = 0; index < claims.length; index += 1) {
        if (!used[index]) {
          pick = index;
          break;
        }
      }
    }
    if (pick < 0) {
      return undefined;
    }
    used[pick] = true;
    return claimSummary((claims[pick] as ExplanationClaim).text);
  });
}
