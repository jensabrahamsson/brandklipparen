// Investigation timeline helpers (S-125): evidence chips resolve to the
// linked signal; narrative citations split into text and chip parts.
import { describe, expect, test } from "vitest";
import { evidenceSignalKey, splitNarrative } from "./investigation.ts";
import type { Signal } from "../types.ts";

function signal(id: string, risk: Signal["risk"] = "honeypot"): Signal {
  return { kind: "capability", id, risk, direction: "raises", severity: "high", evidence: [] };
}

describe("investigation timeline", () => {
  test("s125_evidence_ids_resolve_to_the_first_matching_signal", () => {
    const signals = [signal("owner-blacklist"), signal("owner-blacklist", "rug-pull"), signal("mintable")];
    expect(evidenceSignalKey(signals, "signal:owner-blacklist")).toBe("0-capability-honeypot");
    expect(evidenceSignalKey(signals, "signal:mintable")).toBe("2-capability-honeypot");
    expect(evidenceSignalKey(signals, "signal:unknown")).toBeNull();
    expect(evidenceSignalKey(signals, "ev-1")).toBeNull();
  });

  test("s125_narrative_citations_split_into_text_and_evidence", () => {
    expect(splitNarrative("No citations here.")).toEqual([{ kind: "text", text: "No citations here." }]);
    expect(splitNarrative("Guard holds. [E:signal:owner-blacklist] Done.")).toEqual([
      { kind: "text", text: "Guard holds. " },
      { kind: "evidence", id: "signal:owner-blacklist" },
      { kind: "text", text: " Done." },
    ]);
    expect(splitNarrative("[E:signal:a][E:signal:b]")).toEqual([
      { kind: "evidence", id: "signal:a" },
      { kind: "evidence", id: "signal:b" },
    ]);
  });
});
