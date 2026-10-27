# Label policy for the on-chain dataset (K-202)

Version: 1.0.0.
Status: MVP placeholder for S-017; reviewed with each dataset release.
Scope: this policy settles every label in `dataset-synthetic-v1.json` and in
later datasets that carry `labelPolicyVersion 1.0.0`. Doubtful cases are
settled by the rules below before entry, and each row names the settling
rule in its rationale. The schema of the dataset file is validated by
`src/domain/dataset.ts`; licence and provenance notes live in
`offline/data/README.md`.

## Risk definitions and the negative class per risk

- **Rug pull (positive):** the bytecode gives an authorised party a way to
  take value out of the token, for example an owner mint without a cap, an
  owner withdrawal of pooled funds, or an upgrade path that can install such
  a capability. **Negative:** no such capability is present in the analysed
  bytecode at the recorded block.
- **Honeypot (positive):** the bytecode lets ordinary holders buy while
  blocking or taxing their sale, for example a transfer gate that refuses
  sales from common holders or a sale-only fee that an authorised party can
  raise without bound. **Negative:** sales follow the same code path as
  purchases with no holder-dependent block.
- **Bot pump (positive):** the bytecode favours fast automated buying over
  ordinary holders, for example per-holder caps paired with exempt lists, or
  launch windows that only pre-approved parties can use. **Negative:** no
  exemption or window favours one group of buyers over another.

## Noise rule

Legitimate launch protections can share the shape of a trap: capped amounts
per holder, short trading pauses at launch, or modest sale fees that fund
development. A row that shows only such a protection, with no authorised
withdrawal, no holder-dependent sale block and no exempt buyer list, is
labelled negative on all three risks with the rationale
`noise-rule-launch-protection`. A row that pairs a protection with any
positive capability above is labelled positive for that risk, and the
rationale names the capability rule instead.

## Rationale values

The rationale is a short kebab-case rule id: `no-capability-found`,
`owner-mint-capability`, `transfer-gate-capability`,
`holder-cap-capability`, or `noise-rule-launch-protection`. New rules arrive
with a policy version bump and a note in the dataset release record.

## Spot-check method (versioned)

Label quality is measured with `spotCheckDataset` in
`src/domain/dataset.ts`: rows are ordered by address, the first rows up to
the sample size are re-checked (address, bytecode, code hash, block range,
source, closed label set, non-empty rationale), and the result carries the
data version and the label policy version it was measured under. The named
measurement is `k202_label_quality_spot_check_versioned`.
