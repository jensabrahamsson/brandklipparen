// Investigation types and citation checker (S-072, K-036, K-520, P-31, P-35).
// Test-first: these tests fail until src/domain/investigation.ts lands.
import { describe, expect, test } from "vitest";
import {
  checkCitations,
  transitionInvestigation,
} from "../../../src/domain/investigation.ts";
import type { InvestigationState } from "../../../src/domain/investigation.ts";

function doneState(): InvestigationState {
  return {
    kind: "done",
    report: {
      outcome: "done",
      narrative: "Kept. [E:sig-1]",
      droppedClaims: 0,
      steps: [],
      collectedEvidenceIds: ["sig-1"],
    },
  };
}

function failedState(): InvestigationState {
  return {
    kind: "failed",
    reason: { kind: "step-limit", message: "step budget spent", limit: 8 },
    partial: [],
  };
}

describe("investigation citation checker", () => {
  test("k520_citation_check_keeps_only_sentences_citing_collected_evidence", () => {
    const draft = [
      "The owner can raise the sell fee. [E:sig-1]",
      "The contract mints without cap. [E:sig-unknown]",
      "Fees look high today.",
    ].join(" ");
    const checked = checkCitations(draft, ["sig-1"]);
    expect(checked.narrative).toBe("The owner can raise the sell fee. [E:sig-1]");
    expect(checked.droppedClaims).toBe(2);
  });

  test("k520_citation_check_accepts_runner_prefixed_evidence_ids", () => {
    // Runner-minted ids carry a `signal:` or `doc:` prefix with a colon;
    // the citation marker must match them exactly.
    const draft = [
      "The owner can block sales. [E:signal:owner-blacklist]",
      "The docs describe the guard. [E:doc:fee-capability]",
      "Unrelated chatter without a marker.",
    ].join(" ");
    const checked = checkCitations(draft, ["signal:owner-blacklist", "doc:fee-capability"]);
    expect(checked.narrative).toBe(
      "The owner can block sales. [E:signal:owner-blacklist] The docs describe the guard. [E:doc:fee-capability]",
    );
    expect(checked.droppedClaims).toBe(1);
  });

  test("k520_citation_check_splits_newlines_semicolons_and_caps_length", () => {
    // Newline- and semicolon-joined claims must not ride on one citation:
    // two uncited claims plus one cited claim drop exactly the two.
    const draft = "First claim without a marker\nsecond claim without one either; third one [E:sig-1]";
    const checked = checkCitations(draft, ["sig-1"]);
    expect(checked.droppedClaims).toBe(2);
    expect(checked.narrative).toBe("third one [E:sig-1]");
    // An overlong sentence splits into capped chunks checked on their own:
    // uncited chunks drop while the cited chunk survives.
    const longDraft = `${"word ".repeat(200)}[E:sig-1]`;
    const longChecked = checkCitations(longDraft, ["sig-1"]);
    expect(longChecked.droppedClaims).toBe(2);
    expect(longChecked.narrative).toContain("[E:sig-1]");
  });

  test("k520_zero_surviving_sentences_yields_empty_narrative_with_drop_count", () => {
    // The trailing marker attaches to the sentence it trails, so the
    // draft holds two sentences and both drop: no repaired substitute.
    const draft = "Nothing is cited here. Neither is this. [E:sig-ghost]";
    const checked = checkCitations(draft, ["sig-1"]);
    expect(checked.narrative).toBe("");
    expect(checked.droppedClaims).toBe(2);
  });
});

describe("investigation state machine", () => {
  test("investigation_state_rejects_transition_after_done_or_failed", () => {
    const fromDone = transitionInvestigation(doneState(), { kind: "conclude", draft: "Late. [E:sig-1]" });
    expect(fromDone.ok).toBe(false);
    const fromFailed = transitionInvestigation(failedState(), { kind: "decide" });
    expect(fromFailed.ok).toBe(false);
  });
});
