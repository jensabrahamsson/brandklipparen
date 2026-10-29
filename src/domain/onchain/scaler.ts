// Standardization for continuous on-chain features (issue 1).
// Pure domain module: fit mean/sd per continuous column on TRAIN available
// values only, then apply the stored TRAIN params to test and serving rows.
// Binary columns pass through as 0/1 untouched. A missing value maps to
// exactly 0 after scaling (the TRAIN mean), so it contributes zero to a
// linear head, matching the neutral-zero mapping. No I/O, no clock.
export type ScalerColumn = {
  readonly mean: number;
  readonly sd: number;
  readonly scaled: boolean;
};

export type OnchainScaler = {
  readonly features: readonly string[];
  readonly columns: readonly ScalerColumn[];
};

// Fit on TRAIN only: per continuous column the mean/sd run over the
// available subset (missing rows never drag the mean, or a missing value
// could not map back to zero). A zero-variance column floors sd to 1 so
// applying stays total; binary columns record an identity entry.
export function fitOnchainScaler(
  features: readonly string[],
  isContinuous: (feature: string) => boolean,
  matrix: readonly (readonly number[])[],
  available: readonly (readonly boolean[])[],
): OnchainScaler {
  const columns = features.map((feature, col) => {
    if (!isContinuous(feature)) {
      return Object.freeze({ mean: 0, sd: 1, scaled: false });
    }
    let count = 0;
    let total = 0;
    matrix.forEach((row, rowIndex) => {
      if ((available[rowIndex]?.[col] ?? false) && Number.isFinite(row[col] ?? NaN)) {
        count += 1;
        total += row[col] ?? 0;
      }
    });
    const mean = count === 0 ? 0 : total / count;
    let variance = 0;
    matrix.forEach((row, rowIndex) => {
      if ((available[rowIndex]?.[col] ?? false) && Number.isFinite(row[col] ?? NaN)) {
        const gap = (row[col] ?? 0) - mean;
        variance += gap * gap;
      }
    });
    const sd = count === 0 ? 1 : Math.sqrt(variance / count);
    return Object.freeze({ mean, sd: sd < 1e-12 ? 1 : sd, scaled: true });
  });
  return Object.freeze({ features: Object.freeze([...features]), columns: Object.freeze(columns) });
}

// Apply the stored TRAIN params: binaries pass through, unavailable
// continuous values map to 0 (zero contribution), available ones to
// (value - trainMean) / trainSd.
export function applyOnchainScaler(
  vector: readonly number[],
  rowAvailable: readonly boolean[],
  scaler: OnchainScaler,
): readonly number[] {
  return Object.freeze(
    scaler.features.map((_, col) => {
      const column = scaler.columns[col];
      if (column === undefined || !column.scaled) {
        return vector[col] ?? 0;
      }
      if (!(rowAvailable[col] ?? false)) {
        return 0;
      }
      const value = vector[col] ?? 0;
      if (!Number.isFinite(value)) {
        return 0;
      }
      return (value - column.mean) / column.sd;
    }),
  );
}

// Sidecar form stored beside the candidate artifact so serving applies the
// same transform: raw TRAIN means/sds per feature, never refitted.
export function scalerToJSON(scaler: OnchainScaler): {
  readonly features: readonly string[];
  readonly means: readonly number[];
  readonly sds: readonly number[];
  readonly scaled: readonly boolean[];
} {
  return Object.freeze({
    features: scaler.features,
    means: Object.freeze(scaler.columns.map((column) => column.mean)),
    sds: Object.freeze(scaler.columns.map((column) => column.sd)),
    scaled: Object.freeze(scaler.columns.map((column) => column.scaled)),
  });
}
