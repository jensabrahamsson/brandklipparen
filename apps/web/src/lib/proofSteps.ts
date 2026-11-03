// Step copy for the proof trace ("How we checked", UI v2 §5.5). Pure
// display strings only: every step id maps to a label and a plain
// failure sentence. Unknown ids fall back to the id in sentence case so
// the trace never renders nothing. Never scored, never evidence.
export type ProofStepCopy = {
  readonly label: string;
  readonly failure: string;
};

// Same-slot comparisons share one row (UI v2 §5.5): the owner's setting
// and the transfer check are different ones, whatever the shape.
const SAME_SETTING: ProofStepCopy = Object.freeze({
  label: "Same setting?",
  failure: "Owner setting is not the one transfer checks.",
});

const PROOF_STEP_COPY: Record<string, ProofStepCopy> = Object.freeze({
  "owner-slot": Object.freeze({
    label: "Owner check?",
    failure: "No owner check found.",
  }),
  "writer-regions": Object.freeze({
    label: "Owner-only functions?",
    failure: "No owner-only setter.",
  }),
  "candidate-slots": Object.freeze({
    label: "Setting changed?",
    failure: "No traceable setting.",
  }),
  "candidate-bases": Object.freeze({
    label: "Wallet list changed?",
    failure: "No traceable wallet list.",
  }),
  "packed-write-proof": Object.freeze({
    label: "Write proven?",
    failure: "Write not proven.",
  }),
  "transfer-gate": Object.freeze({
    label: "Transfer reads it?",
    failure: "Transfer never reads it.",
  }),
  "same-slot-and-bit": SAME_SETTING,
  "same-slot": SAME_SETTING,
  "same-base": SAME_SETTING,
  "reverting-jumpi": Object.freeze({
    label: "Failed check stops transfer?",
    failure: "Failed check does not block.",
  }),
  "transfer-use": Object.freeze({
    label: "Transfer uses the rate?",
    failure: "Rate unused in transfers.",
  }),
  subtraction: Object.freeze({
    label: "Fee taken off?",
    failure: "No fee deducted.",
  }),
  "supply-slot": Object.freeze({
    label: "Total supply stored?",
    failure: "Supply slot not found.",
  }),
  "supply-write": Object.freeze({
    label: "Owner-only supply increase?",
    failure: "No owner-only supply increase.",
  }),
  "balance-credit": Object.freeze({
    label: "New tokens credited?",
    failure: "New supply credits no balance.",
  }),
  "increase-proof": Object.freeze({
    label: "Supply increase proven?",
    failure: "Increase not proven.",
  }),
});

// Every step id the proof service can emit (UI v2 §5.5, one per row).
export const PROOF_STEP_IDS: readonly string[] = Object.freeze(Object.keys(PROOF_STEP_COPY));

// Unknown step ids fall back to the id in sentence case: dashes and
// underscores become spaces, the rest lowercases, the first letter caps.
export function sentenceCaseStepId(step: string): string {
  const words = step.replace(/[_-]+/g, " ").trim().toLowerCase();
  if (words.length === 0) {
    return step;
  }
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export function proofStepCopy(step: string): ProofStepCopy {
  return PROOF_STEP_COPY[step] ?? Object.freeze({ label: sentenceCaseStepId(step), failure: sentenceCaseStepId(step) });
}

export function proofStepLabel(step: string): string {
  return proofStepCopy(step).label;
}

export function proofStepFailure(step: string): string {
  return proofStepCopy(step).failure;
}
