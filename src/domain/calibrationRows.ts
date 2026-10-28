// Calibration-tokens shape converter (S-115 calibration readiness).
// Pure domain module: translates the labeled-tokens file shape (one flat
// row per token with a single category label) into the versioned Dataset
// schema the splits, metrics and freeze pipeline consume, then reuses
// parseDataset for every boundary check. No I/O, no clock, no randomness,
// no environment access. The category-to-risk mapping below is
// provisional until the label policy v2 lands: `rug` and `scam` mark the
// rug-pull family, `honeypot` marks the honeypot family, `legit` marks
// every risk negative, and `bot-pump` never goes positive from this file
// (a documented gap). Unknown categories fail with a typed error instead
// of a guessed mapping.
import { LABEL_BASES, parseDataset } from "./dataset.ts";
import type { Dataset, DatasetError, LabelBasis } from "./dataset.ts";
import { err } from "./result.ts";
import type { Result } from "./result.ts";

// Provisional label policy version for converted calibration rows: the
// mapping above is not the reviewed v1 policy, so converted datasets
// never claim it.
export const CALIBRATION_LABEL_POLICY_VERSION = "0.1.0-provisional";

const CALIBRATION_LABELS: readonly string[] = Object.freeze(["legit", "rug", "honeypot", "scam"]);

function invalid(message: string): Result<never, DatasetError> {
  return err({ kind: "invalid-dataset", message });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function labelOf(category: string, rationale: string): Record<string, unknown> | null {
  switch (category) {
    case "legit":
      return { "rug-pull": "negative", honeypot: "negative", "bot-pump": "negative", rationale };
    case "rug":
    case "scam":
      return { "rug-pull": "positive", honeypot: "negative", "bot-pump": "negative", rationale };
    case "honeypot":
      return { "rug-pull": "negative", honeypot: "positive", "bot-pump": "negative", rationale };
    default:
      return null;
  }
}

// Translates calibration rows to a Dataset through parseDataset, so code
// hashes, blocks and label shapes keep their single boundary. Rows carry
// the flat calibration fields (address, bytecode, block, label,
// labelSource, codehash) with optional labelBasis and labelNote; the
// dataset source is the fixed string `calibration` and the rationale is
// the row note, the row source, or the fixed fallback, whichever comes
// first. Deterministic: row order is kept and the block range spans the
// row blocks.
export function calibrationRowsToDataset(
  value: unknown,
  dataVersion: string,
): Result<Dataset, DatasetError> {
  if (!Array.isArray(value)) {
    return invalid("calibration rows must be a JSON array");
  }
  if (value.length === 0) {
    return invalid("calibration rows must carry at least one row");
  }
  if (typeof dataVersion !== "string" || dataVersion.length === 0) {
    return invalid("calibration rows need a non-empty data version");
  }
  const datapoints: Record<string, unknown>[] = [];
  let from = Number.MAX_SAFE_INTEGER;
  let to = 0;
  for (let index = 0; index < value.length; index += 1) {
    const raw = value[index];
    if (!isRecord(raw)) {
      return invalid(`calibration row at index ${index} must be an object`);
    }
    const category = raw["label"];
    if (typeof category !== "string" || !CALIBRATION_LABELS.includes(category)) {
      return invalid(`calibration row at index ${index} carries an unknown label`);
    }
    const basis = raw["labelBasis"];
    if (basis !== undefined && (typeof basis !== "string" || !LABEL_BASES.includes(basis as LabelBasis))) {
      return invalid(`calibration row at index ${index} carries an unknown label basis`);
    }
    const note = raw["labelNote"];
    if (note !== undefined && typeof note !== "string") {
      return invalid(`calibration row at index ${index} carries a non-string label note`);
    }
    const source = raw["labelSource"];
    const rationale =
      (typeof note === "string" && note.length > 0 ? note : undefined) ??
      (typeof source === "string" && source.length > 0 ? source : undefined) ??
      "calibration row";
    const label = labelOf(category, rationale);
    if (label === null) {
      return invalid(`calibration row at index ${index} carries an unknown label`);
    }
    const block = raw["block"];
    if (typeof block !== "number" || !Number.isSafeInteger(block) || block < 0) {
      return invalid(`calibration row at index ${index} must carry an integer block`);
    }
    if (block < from) {
      from = block;
    }
    if (block > to) {
      to = block;
    }
    const point: Record<string, unknown> = {
      address: raw["address"],
      bytecode: raw["bytecode"],
      blockNumber: block,
      source: "calibration",
      label,
    };
    if (typeof raw["codehash"] === "string") {
      point["codeHash"] = raw["codehash"];
    }
    if (basis !== undefined) {
      point["labelBasis"] = basis;
    }
    if (typeof note === "string" && note.length > 0) {
      point["labelNote"] = note;
    }
    datapoints.push(point);
  }
  return parseDataset({
    dataVersion,
    labelPolicyVersion: CALIBRATION_LABEL_POLICY_VERSION,
    blockRange: { from, to },
    datapoints,
  });
}
