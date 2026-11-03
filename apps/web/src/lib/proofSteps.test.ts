// Proof-step copy (UI v2 §5.5, W-11): every step id maps to a label
// and a plain failure sentence; unknown ids fall back to the id in
// sentence case. Behavior only: rendered strings, no internals.
import { describe, expect, test } from "vitest";
import { PROOF_STEP_IDS, proofStepCopy, proofStepFailure, proofStepLabel, sentenceCaseStepId } from "./proofSteps.ts";

describe("proof step copy", () => {
  test("every known step id maps to a label and a plain failure sentence", () => {
    expect(PROOF_STEP_IDS).toHaveLength(16);
    for (const step of PROOF_STEP_IDS) {
      const copy = proofStepCopy(step);
      expect(copy.label.length).toBeGreaterThan(0);
      expect(copy.failure.length).toBeGreaterThan(0);
      expect(copy.label).not.toContain("_");
      expect(copy.failure.endsWith(".")).toBe(true);
    }
  });

  test("the failure sentences name the check in plain words", () => {
    expect(proofStepFailure("owner-slot")).toBe(
      "No owner check found.",
    );
    expect(proofStepFailure("transfer-gate")).toBe("Transfer never reads it.");
    expect(proofStepFailure("reverting-jumpi")).toBe("Failed check does not block.");
    expect(proofStepFailure("supply-write")).toBe("No owner-only supply increase.");
  });

  test("same-slot shapes share one label and sentence", () => {
    expect(proofStepLabel("same-slot-and-bit")).toBe("Same setting?");
    expect(proofStepLabel("same-slot")).toBe("Same setting?");
    expect(proofStepLabel("same-base")).toBe("Same setting?");
    expect(proofStepFailure("same-slot")).toBe(
      "Owner setting is not the one transfer checks.",
    );
  });

  test("unknown ids fall back to the id in sentence case", () => {
    expect(sentenceCaseStepId("my-custom-step")).toBe("My custom step");
    expect(proofStepLabel("my-custom-step")).toBe("My custom step");
    expect(proofStepFailure("my-custom-step")).toBe("My custom step");
    expect(proofStepLabel("packed_write_proof_v2")).toBe("Packed write proof v2");
  });
});
