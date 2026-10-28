// Sample weights by label strength (real calibration follow-up).
// Pure domain module: maps one calibration row to a fitting weight from
// its provenance. Corroborated rows (labelNote names several datasets)
// and incident-report rows are strongest, curated dataset rows follow
// with token-list legit at the same level, and the rule-based
// "Do not rug on me" scam set is weakest. Unknown rows carry weight 0
// so fitting skips them. No I/O, no clock, no randomness.
import { err, ok } from "./result.ts";
import type { Result } from "./result.ts";

export type SampleWeightConfig = {
  readonly corroborated: number;
  readonly incidentReport: number;
  readonly dataset: number;
  readonly tokenListLegit: number;
  readonly doNotRug: number;
};

export const SAMPLE_WEIGHT_DEFAULTS: SampleWeightConfig = Object.freeze({
  corroborated: 3,
  incidentReport: 3,
  dataset: 2,
  tokenListLegit: 2,
  doNotRug: 0.5,
});

export const MIN_SAMPLE_WEIGHT = 0.1;
export const MAX_SAMPLE_WEIGHT = 100;

export type SampleWeightError = { kind: "invalid-sample-weights"; message: string };

function invalid(message: string): Result<never, SampleWeightError> {
  return err({ kind: "invalid-sample-weights", message });
}

function isWeight(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= MIN_SAMPLE_WEIGHT && value <= MAX_SAMPLE_WEIGHT;
}

export function parseSampleWeights(input: unknown): Result<SampleWeightConfig, SampleWeightError> {
  const base: Record<keyof SampleWeightConfig, number> = {
    corroborated: SAMPLE_WEIGHT_DEFAULTS.corroborated,
    incidentReport: SAMPLE_WEIGHT_DEFAULTS.incidentReport,
    dataset: SAMPLE_WEIGHT_DEFAULTS.dataset,
    tokenListLegit: SAMPLE_WEIGHT_DEFAULTS.tokenListLegit,
    doNotRug: SAMPLE_WEIGHT_DEFAULTS.doNotRug,
  };
  if (input === undefined) {
    return ok(Object.freeze({ ...base }));
  }
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return invalid("sample weights must be an object mapping strength classes to weights");
  }
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (!(key in base)) {
      return invalid(`unknown sample weight class: ${key}`);
    }
    if (!isWeight(value)) {
      return invalid(`sample weight for ${key} must be a finite number from ${MIN_SAMPLE_WEIGHT} to ${MAX_SAMPLE_WEIGHT}`);
    }
    base[key as keyof SampleWeightConfig] = value as number;
  }
  return ok(Object.freeze({ ...base }));
}

export type WeightRow = {
  readonly label: string;
  readonly labelBasis?: string | undefined;
  readonly labelSource?: string | undefined;
  readonly labelNote?: string | undefined;
};

export function isCorroborated(row: Pick<WeightRow, "labelNote">): boolean {
  return (row.labelNote ?? "").includes("Corroborated by");
}

export function isDoNotRugPrimary(row: Pick<WeightRow, "labelSource">): boolean {
  return (row.labelSource ?? "").includes("Do not rug on me labeled_list.csv");
}

export function sampleWeightOf(
  row: WeightRow,
  config: SampleWeightConfig = SAMPLE_WEIGHT_DEFAULTS,
): number {
  if (row.label === "unknown") {
    return 0;
  }
  if (isDoNotRugPrimary(row)) {
    return config.doNotRug;
  }
  if (isCorroborated(row)) {
    return config.corroborated;
  }
  if (row.labelBasis === "incident-report") {
    return config.incidentReport;
  }
  if (row.labelBasis === "token-list") {
    return row.label === "legit" ? config.tokenListLegit : config.dataset;
  }
  return config.dataset;
}
