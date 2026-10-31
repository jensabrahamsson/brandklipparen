// Investigation timeline helpers (S-125): evidence ids resolve to the
// position-derived signal keys the signal list uses, and checked
// narrative citations split into text and evidence chips.
import { signalKey } from "./signals.ts";
import type { Signal } from "../types.ts";

const EVIDENCE_PREFIX = "signal:";

// Map a frozen evidence id ("signal:<id>") to the position-derived signal
// key of its first matching signal, so evidence chips move focus to the
// linked signal and expand it. Duplicate signal ids resolve to their first
// occurrence; unknown or non-signal ids link nowhere.
export function evidenceSignalKey(signals: readonly Signal[], evidenceId: string): string | null {
  if (!evidenceId.startsWith(EVIDENCE_PREFIX)) {
    return null;
  }
  const id = evidenceId.slice(EVIDENCE_PREFIX.length);
  const index = signals.findIndex((signal) => signal.id === id);
  if (index === -1) {
    return null;
  }
  const signal = signals[index];
  if (signal === undefined) {
    return null;
  }
  return signalKey(signal, index);
}

export type NarrativePart = { readonly kind: "text"; readonly text: string } | { readonly kind: "evidence"; readonly id: string };

// Split a checked narrative on [E:<evidence>] citations into ordered text
// and evidence parts. The kept narrative may carry tolerated marker
// variants (`[e: id]`, several ids per marker, backticked ids), so markers
// parse the same way as the citation check: split multi-id markers and
// normalise each id before it becomes a chip. Plain text without
// citations stays a single part.
export function splitNarrative(narrative: string): NarrativePart[] {
  const parts: NarrativePart[] = [];
  const pattern = /\[\s*[Ee]\s*:\s*([^\]]+)\]/g;
  let last = 0;
  for (let match = pattern.exec(narrative); match !== null; match = pattern.exec(narrative)) {
    if (match.index > last) {
      parts.push({ kind: "text", text: narrative.slice(last, match.index) });
    }
    const inner = match[1] ?? "";
    let pushed = false;
    for (const entry of inner.split(/[,;]/)) {
      const id = entry.trim().replace(/^`+|`+$/g, "").trim();
      if (id.length > 0) {
        parts.push({ kind: "evidence", id });
        pushed = true;
      }
    }
    if (!pushed) {
      parts.push({ kind: "text", text: match[0] });
    }
    last = match.index + match[0].length;
  }
  if (last < narrative.length) {
    parts.push({ kind: "text", text: narrative.slice(last) });
  }
  if (parts.length === 0) {
    parts.push({ kind: "text", text: narrative });
  }
  return parts;
}
