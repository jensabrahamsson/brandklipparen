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
  label: "Check it is the same setting",
  failure: "The owner's setting and the transfer check are different ones.",
});

const PROOF_STEP_COPY: Record<string, ProofStepCopy> = Object.freeze({
  "owner-slot": Object.freeze({
    label: "Find the owner check",
    failure: "We found no stored owner that the code compares with the caller.",
  }),
  "writer-regions": Object.freeze({
    label: "Find owner-only functions",
    failure: "No owner-only function changes a setting.",
  }),
  "candidate-slots": Object.freeze({
    label: "Find the setting they change",
    failure: "Those functions change no single setting we could follow.",
  }),
  "candidate-bases": Object.freeze({
    label: "Find the per-wallet list they change",
    failure: "Those functions change no per-wallet list we could follow.",
  }),
  "packed-write-proof": Object.freeze({
    label: "Prove the function writes it",
    failure: "We could not prove the function really writes that setting.",
  }),
  "transfer-gate": Object.freeze({
    label: "Find where transfer reads it",
    failure: "transfer() never reads that setting.",
  }),
  "same-slot-and-bit": SAME_SETTING,
  "same-slot": SAME_SETTING,
  "same-base": SAME_SETTING,
  "reverting-jumpi": Object.freeze({
    label: "Check a failed check stops the transfer",
    failure: "A failed check does not stop the transfer.",
  }),
  "transfer-use": Object.freeze({
    label: "Check transfer uses the rate",
    failure: "transfer() never uses that rate to compute an amount.",
  }),
  subtraction: Object.freeze({
    label: "Check the fee is taken off",
    failure: "The fee is never taken off the amount.",
  }),
  "supply-slot": Object.freeze({
    label: "Find the total supply",
    failure: "We could not find where the total supply is stored.",
  }),
  "supply-write": Object.freeze({
    label: "Find an owner-only supply increase",
    failure: "No owner-only function raises the total supply.",
  }),
  "balance-credit": Object.freeze({
    label: "Check new tokens land in a balance",
    failure: "New supply is not added to any balance.",
  }),
  "increase-proof": Object.freeze({
    label: "Prove supply only goes up there",
    failure: "We could not prove the supply goes up there.",
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
