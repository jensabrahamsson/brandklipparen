// Fresh public on-chain dataset with a versioned label policy (K-201,
// K-202, S-017). Pure domain module: validation of the versioned dataset
// schema, label roll-up to the training input shape for S-019, and the
// deterministic label spot check. No I/O, no clock, no randomness, no
// environment access, no platform imports. Detection thresholds, weights
// and limits never live here; they belong to the versioned model artifact
// per K-210 and A-20.
import { err, ok } from "./result.ts";
import type { Result } from "./result.ts";
import type { RiskType } from "./signals.ts";
import { Address, BlockNumber, Bytecode, CodeHash } from "./types.ts";
import type {
  Address as AddressType,
  BlockNumber as BlockNumberType,
  Bytecode as BytecodeType,
  CodeHash as CodeHashType,
} from "./types.ts";

// Versioned dataset schema and label policy (K-201, K-202). The schema
// version freezes the field layout below; the policy version points at the
// labelled rules in docs/dataset-label-policy.md that each row was checked
// against. Both travel with every dataset file and every spot-check result.
export const DATASET_SCHEMA_VERSION = "1.0.0";
export const LABEL_POLICY_VERSION = "1.0.0";

// Schema bounds (format limits, not model values): provenance strings stay
// short and reviewable, and one file stays bounded for the offline chain.
export const MAX_SOURCE_CHARS = 200;
export const MAX_RATIONALE_CHARS = 500;
export const MAX_VERSION_CHARS = 64;
export const MAX_DATAPOINTS = 10000;

// Closed label set per risk type (K-202): doubtful cases are settled by the
// policy before entry, and the rationale names the settling rule.
export type LabelValue = "positive" | "negative";

export type DatasetLabel = {
  readonly "rug-pull": LabelValue;
  readonly honeypot: LabelValue;
  readonly "bot-pump": LabelValue;
  readonly rationale: string;
};

// Provenance weight class for one datapoint (S-115 calibration
// readiness): curated dataset rows outrank incident reports, which
// outrank token listings. The field is optional and defaults to
// `dataset`; the note is free text under the rationale cap.
export type LabelBasis = "dataset" | "incident-report" | "token-list";

export const LABEL_BASES: readonly LabelBasis[] = Object.freeze(["dataset", "incident-report", "token-list"]);

export type DatasetDataPoint = {
  readonly address: AddressType;
  readonly bytecode: BytecodeType;
  readonly blockNumber: BlockNumberType;
  readonly source: string;
  readonly codeHash: CodeHashType;
  readonly label: DatasetLabel;
  readonly labelBasis?: LabelBasis | undefined;
  readonly labelNote?: string | undefined;
};

// Default per-row weights by provenance (S-115): curated dataset rows
// count triple, incident reports double, token listings single. The
// ordering is principled (verified rows above write-ups above hearsay
// listings) and every entry point accepts overrides; the values steer
// counts only, never thresholds.
export const BASIS_WEIGHT_DEFAULTS: Readonly<Record<LabelBasis, number>> = Object.freeze({
  dataset: 3,
  "incident-report": 2,
  "token-list": 1,
});

// Bounds for configured basis weights (format limits, not model values):
// positive integers, so expansion by replication stays finite and exact.
export const MAX_BASIS_WEIGHT = 100;

function basisWeightError(message: string): Result<never, DatasetError> {
  return err({ kind: "invalid-dataset", message });
}

// Validated basis-weight overrides (S-115): a partial mapping fills from
// the defaults, so callers override one class without restating the
// others. Unknown classes, non-integer or out-of-range weights fail.
export function parseBasisWeights(input: unknown): Result<Readonly<Record<LabelBasis, number>>, DatasetError> {
  const weights: Record<LabelBasis, number> = {
    dataset: BASIS_WEIGHT_DEFAULTS.dataset ?? 3,
    "incident-report": BASIS_WEIGHT_DEFAULTS["incident-report"] ?? 2,
    "token-list": BASIS_WEIGHT_DEFAULTS["token-list"] ?? 1,
  };
  if (input === undefined) {
    return ok(Object.freeze(weights));
  }
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return basisWeightError("basis weights must be an object mapping label bases to weights");
  }
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (!LABEL_BASES.includes(key as LabelBasis)) {
      return basisWeightError(`unknown label basis in weights: ${key}`);
    }
    if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > MAX_BASIS_WEIGHT) {
      return basisWeightError(`basis weight for ${key} must be an integer from 1 to ${MAX_BASIS_WEIGHT}`);
    }
    weights[key as LabelBasis] = value;
  }
  return ok(Object.freeze(weights));
}

// Weight of one datapoint under the given (or default) weights: the
// datapoint's own basis, or `dataset` when it carries none.
export function basisWeightOf(
  point: Pick<DatasetDataPoint, "labelBasis">,
  weights: Readonly<Record<LabelBasis, number>> = BASIS_WEIGHT_DEFAULTS,
): number {
  return weights[point.labelBasis ?? "dataset"] ?? 1;
}

// Expansion by replication (S-115): each datapoint repeats its basis
// weight times in input order, so weighted counts and weighted metrics
// follow from the plain unweighted pipeline with no fractional
// arithmetic anywhere.
export function expandByBasisWeight(
  points: readonly DatasetDataPoint[],
  weights: Readonly<Record<LabelBasis, number>> = BASIS_WEIGHT_DEFAULTS,
): readonly DatasetDataPoint[] {
  const out: DatasetDataPoint[] = [];
  for (const point of points) {
    const times = basisWeightOf(point, weights);
    for (let copy = 0; copy < times; copy += 1) {
      out.push(point);
    }
  }
  return Object.freeze(out);
}

export type Dataset = {
  readonly dataVersion: string;
  readonly labelPolicyVersion: string;
  readonly blockRange: { readonly from: number; readonly to: number };
  readonly datapoints: readonly DatasetDataPoint[];
};

export type DatasetError = { kind: "invalid-dataset"; message: string };

// Label counts per risk type: the training input shape the freeze path in
// S-019 consumes as its risk-outcome section.
export type RiskOutcomes = Record<RiskType, { readonly positives: number; readonly negatives: number }>;

// Versioned spot-check outcome (K-202): the counts travel with the data
// version and the label policy version they were measured under.
export type SpotCheckResult = {
  readonly dataVersion: string;
  readonly labelPolicyVersion: string;
  readonly checked: number;
  readonly issues: number;
  readonly passPercent: number;
};

// Fixed risk order (lexicographic): every per-risk loop follows one order,
// so equal inputs give bit-identical counts on every platform (A-32).
const RISK_ORDER: readonly RiskType[] = Object.freeze(["bot-pump", "honeypot", "rug-pull"]);

function invalid(message: string): Result<never, DatasetError> {
  return err({ kind: "invalid-dataset", message });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isVersionString(value: unknown): value is string {
  return typeof value === "string" && value.length >= 1 && value.length <= MAX_VERSION_CHARS;
}

function parseLabel(raw: unknown): DatasetLabel | null {
  if (!isRecord(raw)) {
    return null;
  }
  const keys = Object.keys(raw).sort();
  if (keys.length !== 4 || keys[0] !== "bot-pump" || keys[1] !== "honeypot" || keys[2] !== "rationale" || keys[3] !== "rug-pull") {
    return null;
  }
  const label = {} as Record<RiskType, LabelValue>;
  for (const risk of RISK_ORDER) {
    const value = raw[risk];
    if (value !== "positive" && value !== "negative") {
      return null;
    }
    label[risk] = value;
  }
  const rationale = raw["rationale"];
  if (typeof rationale !== "string" || rationale.length < 1 || rationale.length > MAX_RATIONALE_CHARS) {
    return null;
  }
  return Object.freeze({
    "rug-pull": label["rug-pull"],
    honeypot: label["honeypot"],
    "bot-pump": label["bot-pump"],
    rationale,
  });
}

function parseDataPoint(raw: unknown): DatasetDataPoint | null {
  if (!isRecord(raw)) {
    return null;
  }
  if (typeof raw["address"] !== "string") {
    return null;
  }
  const address = Address.parse(raw["address"]);
  if (!address.ok) {
    return null;
  }
  if (typeof raw["bytecode"] !== "string") {
    return null;
  }
  const bytecode = Bytecode.parse(raw["bytecode"]);
  if (!bytecode.ok || bytecode.value.length < 1) {
    return null;
  }
  if (typeof raw["blockNumber"] !== "number") {
    return null;
  }
  const block = BlockNumber.of(raw["blockNumber"]);
  if (!block.ok) {
    return null;
  }
  if (typeof raw["source"] !== "string" || raw["source"].length < 1 || raw["source"].length > MAX_SOURCE_CHARS) {
    return null;
  }
  const codeHash = CodeHash.of(bytecode.value);
  if (!codeHash.ok) {
    return null;
  }
  // A carried code hash is verified against the derived one, so a copied
  // row with a stale hash fails at the boundary instead of entering
  // training (K-511).
  if (raw["codeHash"] !== undefined && raw["codeHash"] !== (codeHash.value as string)) {
    return null;
  }
  const label = parseLabel(raw["label"]);
  if (label === null) {
    return null;
  }
  let labelBasis: LabelBasis | undefined;
  if (raw["labelBasis"] !== undefined) {
    if (typeof raw["labelBasis"] !== "string" || !LABEL_BASES.includes(raw["labelBasis"] as LabelBasis)) {
      return null;
    }
    labelBasis = raw["labelBasis"] as LabelBasis;
  }
  let labelNote: string | undefined;
  if (raw["labelNote"] !== undefined) {
    if (
      typeof raw["labelNote"] !== "string" ||
      raw["labelNote"].length < 1 ||
      raw["labelNote"].length > MAX_RATIONALE_CHARS
    ) {
      return null;
    }
    labelNote = raw["labelNote"];
  }
  return {
    address: address.value,
    bytecode: bytecode.value,
    blockNumber: block.value,
    source: raw["source"],
    codeHash: codeHash.value,
    label,
    ...(labelBasis === undefined ? {} : { labelBasis }),
    ...(labelNote === undefined ? {} : { labelNote }),
  };
}

// Boundary validation for the versioned dataset file (K-201, A-11, A-16):
// unknown JSON becomes a typed Dataset or one typed error. After the
// boundary each value carries its proof of validity in its type.
export function parseDataset(value: unknown): Result<Dataset, DatasetError> {
  if (!isRecord(value)) {
    return invalid("dataset must be a JSON object");
  }
  if (!isVersionString(value["dataVersion"])) {
    return invalid("dataset must carry a non-empty dataVersion");
  }
  if (!isVersionString(value["labelPolicyVersion"])) {
    return invalid("dataset must carry a non-empty labelPolicyVersion");
  }
  if (!isRecord(value["blockRange"])) {
    return invalid("dataset must carry a blockRange object");
  }
  const from = value["blockRange"]["from"];
  const to = value["blockRange"]["to"];
  if (typeof from !== "number" || !Number.isSafeInteger(from) || from < 0) {
    return invalid("dataset blockRange.from must be an integer at least 0");
  }
  if (typeof to !== "number" || !Number.isSafeInteger(to) || to < 0) {
    return invalid("dataset blockRange.to must be an integer at least 0");
  }
  if (from > to) {
    return invalid("dataset blockRange.from must not lie after blockRange.to");
  }
  if (!Array.isArray(value["datapoints"])) {
    return invalid("dataset must carry a datapoints array");
  }
  const rows: unknown[] = value["datapoints"];
  if (rows.length < 1 || rows.length > MAX_DATAPOINTS) {
    return invalid("dataset must carry at least one datapoint");
  }
  const datapoints: DatasetDataPoint[] = [];
  for (let index = 0; index < rows.length; index += 1) {
    const point = parseDataPoint(rows[index]);
    if (point === null) {
      return invalid(`datapoint at index ${index} must carry address, bytecode, blockNumber, source and a policy label`);
    }
    if ((point.blockNumber as number) < from || (point.blockNumber as number) > to) {
      return invalid(`datapoint at index ${index} must lie inside the dataset blockRange`);
    }
    datapoints.push(point);
  }
  return ok({
    dataVersion: value["dataVersion"],
    labelPolicyVersion: value["labelPolicyVersion"],
    blockRange: { from, to },
    datapoints: Object.freeze(datapoints),
  });
}

// Label roll-up to the training input shape (S-019): counts of positive
// and negative labels per risk type, in the fixed risk order.
export function summarizeForTraining(dataset: Dataset): RiskOutcomes {
  const positives: Record<RiskType, number> = { "rug-pull": 0, honeypot: 0, "bot-pump": 0 };
  const negatives: Record<RiskType, number> = { "rug-pull": 0, honeypot: 0, "bot-pump": 0 };
  for (const point of dataset.datapoints) {
    for (const risk of RISK_ORDER) {
      if (point.label[risk] === "positive") {
        positives[risk] += 1;
      } else {
        negatives[risk] += 1;
      }
    }
  }
  return Object.freeze({
    "rug-pull": Object.freeze({ positives: positives["rug-pull"] ?? 0, negatives: negatives["rug-pull"] ?? 0 }),
    honeypot: Object.freeze({ positives: positives["honeypot"] ?? 0, negatives: negatives["honeypot"] ?? 0 }),
    "bot-pump": Object.freeze({ positives: positives["bot-pump"] ?? 0, negatives: negatives["bot-pump"] ?? 0 }),
  });
}

function pointHasIssue(
  point: DatasetDataPoint,
  range: { readonly from: number; readonly to: number },
): boolean {
  if (!Address.parse(point.address as string).ok) {
    return true;
  }
  const code = Bytecode.parse(bytesToHex(point.bytecode));
  if (!code.ok || code.value.length < 1) {
    return true;
  }
  const derived = CodeHash.of(code.value);
  if (!derived.ok || (derived.value as string) !== (point.codeHash as string)) {
    return true;
  }
  if ((point.blockNumber as number) < range.from || (point.blockNumber as number) > range.to) {
    return true;
  }
  if (point.source.length < 1 || point.source.length > MAX_SOURCE_CHARS) {
    return true;
  }
  for (const risk of RISK_ORDER) {
    if (point.label[risk] !== "positive" && point.label[risk] !== "negative") {
      return true;
    }
  }
  if (point.label.rationale.length < 1 || point.label.rationale.length > MAX_RATIONALE_CHARS) {
    return true;
  }
  if (point.labelBasis !== undefined && !LABEL_BASES.includes(point.labelBasis)) {
    return true;
  }
  if (point.labelNote !== undefined && (point.labelNote.length < 1 || point.labelNote.length > MAX_RATIONALE_CHARS)) {
    return true;
  }
  return false;
}

function bytesToHex(bytes: BytecodeType): string {
  const digits = "0123456789abcdef";
  let out = "0x";
  for (let i = 0; i < bytes.length; i += 1) {
    const byte = bytes[i] ?? 0;
    out += digits[(byte >> 4) & 15] ?? "0";
    out += digits[byte & 15] ?? "0";
  }
  return out;
}

// Deterministic label spot check (K-202): the sampled rows are the first
// rows in lexicographic address order, so the same dataset and sample size
// give the same outcome on every run and platform (A-32). The result
// carries the data version and the label policy version it was measured
// under, so quality stays traceable per data version.
export function spotCheckDataset(dataset: Dataset, sampleSize: number): SpotCheckResult {
  const ordered = dataset.datapoints.slice();
  ordered.sort((left, right) => {
    const leftAddress = left.address as string;
    const rightAddress = right.address as string;
    if (leftAddress < rightAddress) {
      return -1;
    }
    if (leftAddress > rightAddress) {
      return 1;
    }
    return 0;
  });
  const size = Number.isSafeInteger(sampleSize) ? Math.max(0, Math.min(sampleSize, ordered.length)) : 0;
  let issues = 0;
  for (let i = 0; i < size; i += 1) {
    const point = ordered[i];
    if (point !== undefined && pointHasIssue(point, dataset.blockRange)) {
      issues += 1;
    }
  }
  const passPercent = size === 0 ? 100 : Math.floor(((size - issues) * 100) / size);
  return {
    dataVersion: dataset.dataVersion,
    labelPolicyVersion: dataset.labelPolicyVersion,
    checked: size,
    issues,
    passPercent,
  };
}
