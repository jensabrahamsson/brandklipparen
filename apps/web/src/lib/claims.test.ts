// Claim summaries and signal-to-claim assignment (S-116, S-120).
// Template claims arrive as long multi-sentence strings; the UI shows a
// short summary first and keeps the raw detail on demand. Claims map to
// signals by position and risk, never by signal id, so duplicate ids
// cannot misattribute evidence.
import { describe, expect, test } from "vitest";
import { assignTemplateLines, claimSummary, extractAccount, extractEvidenceGroups } from "./claims.ts";
import type { ExplanationClaim, Signal } from "../types.ts";

function testSignal(id: string, risk: "rug-pull" | "honeypot" | "bot-pump"): Signal {
  return {
    kind: "capability",
    id,
    risk,
    direction: "raises",
    severity: "high",
    evidence: [{ selector: "0x44337ea1", offset: 1 }],
  };
}

function testClaim(text: string, signalLinks: readonly string[]): ExplanationClaim {
  return { text, signalLinks, temporality: { kind: "can-change" } };
}

describe("claim summaries (S-116)", () => {
  test("removes raw values and selector fragments from visible findings", () => {
    expect(claimSummary("Calls other contracts (in `0x00000000`). Holds now: the stored value is 0x00000000.")).toBe("Calls other contracts.");
  });
  test("s116_claim_summary_keeps_sentences_before_can_change", () => {
    const text =
      "The contract code lets an account move funds out of the contract. " +
      "This raises the rug-pull risk (severity high). " +
      "Can change: account 0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef can activate this later. " +
      "Evidence: selector 0x40c10f19 at byte offset 500.";
    const summary = claimSummary(text);
    expect(summary).toContain("move funds out of the contract");
    expect(summary).toContain("rug-pull risk");
    expect(summary).not.toContain("Can change:");
    expect(summary).not.toContain("Evidence:");
    expect(summary.length).toBeLessThanOrEqual(200);
  });

  test("s116_template_lines_follow_risk_not_id", () => {
    const signals = [testSignal("shared", "rug-pull"), testSignal("shared", "honeypot")];
    const claims = [
      testClaim("The owner can stop you from selling. This raises the honeypot risk (severity high).", ["shared"]),
      testClaim("The contract code lets an account move funds out. This raises the rug-pull risk (severity high).", [
        "shared",
      ]),
    ];
    // Document order here is honeypot-first, but each signal still gets
    // its own risk kind regardless of shared ids.
    const lines = assignTemplateLines(signals, claims);
    expect(lines[0]?.toLowerCase()).toContain("rug-pull");
    expect(lines[1]?.toLowerCase()).toContain("honeypot");
  });
});

describe("evidence parsing (S-120)", () => {
  const ADDRESS = `0x${"11".repeat(20)}`;
  const text =
    "The contract code lets an account move funds out of the contract. " +
    "This raises the rug-pull risk (severity high). " +
    `Can change: account ${ADDRESS} can activate this later. ` +
    'Evidence: selector 0x40c10f19 at byte offset 500 (decompiled line 50 reads "Unresolved_0x40()"); ' +
    'selector 0x40c10f19 at byte offset 512 (decompiled line 50 reads "Unresolved_0x40()"); ' +
    "selector 0x70a08231 with no byte offset.";

  test("s120_extract_account_finds_the_changer", () => {
    expect(extractAccount(text)).toBe(ADDRESS);
    expect(extractAccount("No account here.")).toBeNull();
  });

  test("s120_extract_evidence_groups_selector_once_with_offsets", () => {
    const groups = extractEvidenceGroups(text);
    expect(groups).toHaveLength(2);
    expect(groups[0]?.selector).toBe("0x40c10f19");
    expect(groups[0]?.offsets).toEqual([500, 512]);
    expect(groups[0]?.snippet).toBe("Unresolved_0x40()");
    expect(groups[1]?.selector).toBe("0x70a08231");
    expect(groups[1]?.offsets).toEqual([]);
  });
});
