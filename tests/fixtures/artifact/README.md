# Synthetic placeholder training dataset

`synthetic-dataset-v1.json` is the small synthetic placeholder dataset for
the frozen calibration artifact (K-211, S-019). Every number is a small
hand-picked placeholder with no predictive meaning: the freeze in
`src/domain/artifact.ts` derives the scoring weights from these counts with
documented frequency ratios (severity weights divide by the largest count,
cause weights divide by the total, biases negate the negative share per
risk, score weights divide by the share total, calibration stays the
identity). Production values arrive through the versioned offline
calibration chain per A-28 and K-210.

The `seed` field is the locked seed for this dataset: the frozen artifact
logs it, and `k211_retraining_reproduces_artifact_bit_identical` requires
the logged seed to match this configuration (M-19). Regenerate the frozen
artifact with `npm run freeze-artifact` after changing this file.
