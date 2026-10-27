// Deterministic training ("freeze") of the versioned calibration artifact
// (K-211, S-019). Pure: no I/O, no clock, no randomness, no environment
// access, no platform imports. The freeze builds the scoring artifact from
// the small synthetic placeholder dataset under tests/fixtures/artifact,
// serializes it with the shared canonical serialization (A-32 point 5) and
// records a SHA-256 checksum over the canonical bytes (A-20). The same
// dataset and version give byte-identical output on every run and on
// every machine. Production thresholds, weights and limits arrive through
// the versioned offline calibration chain per A-28 and K-210; the frequency
// ratios below are the documented placeholder method with no predictive
// meaning.
import { err, ok } from "./result.ts";
import type { Result } from "./result.ts";
import { parseModelArtifact } from "./risk.ts";
import type { ModelArtifact } from "./risk.ts";
import { canonicalBytes, canonicalSerialize, sha256Hex } from "./serialize.ts";
import type { CanonicalValue } from "./serialize.ts";
import type { DomainError } from "./types.ts";
import { ArtifactChecksum } from "./types.ts";
import type {
  ArtifactChecksum as ArtifactChecksumType,
  ModelVersion as ModelVersionType,
} from "./types.ts";
import type { HardToAnalyzeCause, RiskType, Severity } from "./signals.ts";

// Fixed key orders shared with the risk model (lexicographic): every
// per-group loop follows one order, so equal inputs give bit-identical
// output on every platform (A-32).
const SEVERITY_ORDER: readonly Severity[] = Object.freeze(["high", "low", "medium"]);

const CAUSE_ORDER: readonly HardToAnalyzeCause[] = Object.freeze([
  "decompiler-error",
  "obfuscated-structure",
  "resource-limit",
  "timeout",
]);

const RISK_ORDER: readonly RiskType[] = Object.freeze(["bot-pump", "honeypot", "rug-pull"]);

// Placeholder calibration identity (A-28, K-210): the synthetic freeze fits
// no calibrator yet, so the slope stays one and the intercept stays zero and
// the evaluation report records the identity.
const PLACEHOLDER_SLOPE = 1;
const PLACEHOLDER_INTERCEPT = 0;

// The trained values beside the logged data version and locked seed (M-19).
export type TrainedArtifact = {
  readonly artifact: ModelArtifact;
  readonly dataVersion: string;
  readonly seed: number;
};

// The verified file content: the trained values beside the recorded
// SHA-256 checksum over the canonical artifact bytes (A-20).
export type VerifiedArtifact = {
  readonly artifact: ModelArtifact;
  readonly checksum: ArtifactChecksumType;
  readonly dataVersion: string;
  readonly seed: number;
};

// Verification outcome for a frozen file (A-15): a malformed file cannot be
// parsed, while a well-formed file with a changed byte carries a checksum
// mismatch. Both branches stay typed, so scoring refuses unverified
// artifacts through ModelArtifactPort.
export type ArtifactVerificationError =
  | { kind: "malformed"; message: string }
  | { kind: "checksum-mismatch"; message: string };

function invalidArtifact(message: string): Result<never, DomainError> {
  return err({ kind: "invalid-model-artifact", message });
}

function malformed(message: string): Result<never, ArtifactVerificationError> {
  return err({ kind: "malformed", message });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function readCounts<Kind extends string>(
  holder: Record<string, unknown>,
  field: string,
  keys: readonly Kind[],
): Record<Kind, number> | null {
  const raw = holder[field];
  if (!isRecord(raw)) {
    return null;
  }
  const entries = Object.entries(raw);
  if (entries.length !== keys.length) {
    return null;
  }
  const out = {} as Record<Kind, number>;
  for (const key of keys) {
    const value = raw[key];
    if (!isCount(value)) {
      return null;
    }
    out[key] = value;
  }
  return out;
}

// Canonical artifact form for the checksum (A-20, A-32 point 5): the fixed
// shape holds every model value the risk function reads, and
// canonicalSerialize normalizes the key order, so the checksum covers each
// value independent of object insertion order.
export function artifactToCanonical(artifact: ModelArtifact): CanonicalValue {
  const calibration: Record<string, CanonicalValue> = {};
  for (const risk of RISK_ORDER) {
    const params = artifact.calibration[risk];
    calibration[risk] = { intercept: params?.intercept ?? 0, slope: params?.slope ?? 0 };
  }
  const causeWeights: Record<string, CanonicalValue> = {};
  for (const cause of CAUSE_ORDER) {
    causeWeights[cause] = artifact.causeWeights[cause] ?? 0;
  }
  const severityWeights: Record<string, CanonicalValue> = {};
  for (const severity of SEVERITY_ORDER) {
    severityWeights[severity] = artifact.severityWeights[severity] ?? 0;
  }
  const biases: Record<string, CanonicalValue> = {};
  const scoreWeights: Record<string, CanonicalValue> = {};
  for (const risk of RISK_ORDER) {
    biases[risk] = artifact.biases[risk] ?? 0;
    scoreWeights[risk] = artifact.scoreWeights[risk] ?? 0;
  }
  return {
    biases,
    calibration,
    causeWeights,
    scoreWeights,
    severityWeights,
    version: artifact.version as string,
  };
}

// SHA-256 over the canonical artifact bytes (A-20). The digest always holds
// 64 lowercase hex characters, so parsing it back always succeeds; a failure
// would mean a broken digest helper, which surfaces as a typed artifact
// error rather than an exception.
export function checksumForArtifact(artifact: ModelArtifact): Result<ArtifactChecksumType, DomainError> {
  const digest = sha256Hex(canonicalBytes(artifactToCanonical(artifact)));
  const parsed = ArtifactChecksum.parse(digest);
  if (!parsed.ok) {
    return invalidArtifact("artifact checksum digest is not 64 hex characters");
  }
  return ok(parsed.value);
}

// Deterministic training from the synthetic placeholder dataset: severity
// weights divide each count by the largest severity count, cause weights
// divide each count by the cause total, biases negate the negative share per
// risk, score weights divide each share by the share total, and calibration
// stays the placeholder identity. Unknown input gives a typed
// invalid-model-artifact error; valid input gives the trained values with
// the logged data version and locked seed.
export function trainArtifact(input: unknown, version: ModelVersionType): Result<TrainedArtifact, DomainError> {
  if (!isRecord(input)) {
    return invalidArtifact("training dataset must be an object");
  }
  const topKeys = Object.keys(input).sort();
  const expectedTop = ["causeCounts", "dataVersion", "riskOutcomes", "riskShares", "seed", "severityCounts"].sort();
  if (topKeys.length !== expectedTop.length || topKeys.some((key, index) => key !== expectedTop[index])) {
    return invalidArtifact(
      "training dataset must carry exactly dataVersion, seed, severityCounts, causeCounts, riskOutcomes and riskShares",
    );
  }
  const dataVersion = input["dataVersion"];
  if (typeof dataVersion !== "string" || dataVersion.length === 0) {
    return invalidArtifact("training dataset dataVersion must be a non-empty string");
  }
  const seed = input["seed"];
  if (typeof seed !== "number" || !Number.isInteger(seed) || seed < 0) {
    return invalidArtifact("training dataset seed must be an integer at least 0");
  }
  const severityCounts = readCounts(input, "severityCounts", SEVERITY_ORDER);
  if (severityCounts === null) {
    return invalidArtifact("training dataset severityCounts must map every severity to an integer count");
  }
  const causeCounts = readCounts(input, "causeCounts", CAUSE_ORDER);
  if (causeCounts === null) {
    return invalidArtifact("training dataset causeCounts must map every hard-to-analyze cause to an integer count");
  }
  const riskShares = readCounts(input, "riskShares", RISK_ORDER);
  if (riskShares === null) {
    return invalidArtifact("training dataset riskShares must map every risk type to an integer count");
  }
  const rawOutcomes = input["riskOutcomes"];
  if (!isRecord(rawOutcomes) || Object.keys(rawOutcomes).length !== RISK_ORDER.length) {
    return invalidArtifact("training dataset riskOutcomes must carry outcomes per risk type");
  }
  const positives: Record<RiskType, number> = {} as Record<RiskType, number>;
  const negatives: Record<RiskType, number> = {} as Record<RiskType, number>;
  for (const risk of RISK_ORDER) {
    const entry = rawOutcomes[risk];
    if (!isRecord(entry)) {
      return invalidArtifact(`training dataset riskOutcomes for ${risk} must be an object`);
    }
    const entryKeys = Object.keys(entry).sort();
    if (entryKeys.length !== 2 || entryKeys[0] !== "negatives" || entryKeys[1] !== "positives") {
      return invalidArtifact(`training dataset riskOutcomes for ${risk} must carry exactly positives and negatives`);
    }
    if (!isCount(entry["positives"]) || !isCount(entry["negatives"])) {
      return invalidArtifact(`training dataset riskOutcomes for ${risk} must hold integer counts`);
    }
    positives[risk] = entry["positives"] ?? 0;
    negatives[risk] = entry["negatives"] ?? 0;
  }

  let severityMax = 0;
  for (const severity of SEVERITY_ORDER) {
    severityMax = Math.max(severityMax, severityCounts[severity] ?? 0);
  }
  if (severityMax === 0) {
    return invalidArtifact("training dataset severityCounts must hold at least one positive count");
  }
  let causeTotal = 0;
  for (const cause of CAUSE_ORDER) {
    causeTotal += causeCounts[cause] ?? 0;
  }
  if (causeTotal === 0) {
    return invalidArtifact("training dataset causeCounts must hold at least one positive count");
  }
  let shareTotal = 0;
  for (const risk of RISK_ORDER) {
    shareTotal += riskShares[risk] ?? 0;
  }
  if (shareTotal === 0) {
    return invalidArtifact("training dataset riskShares must hold at least one positive count");
  }
  for (const risk of RISK_ORDER) {
    if ((positives[risk] ?? 0) === 0) {
      return invalidArtifact(`training dataset riskOutcomes for ${risk} must hold at least one positive`);
    }
  }

  const severityWeights: Record<Severity, number> = {} as Record<Severity, number>;
  for (const severity of SEVERITY_ORDER) {
    severityWeights[severity] = (severityCounts[severity] ?? 0) / severityMax;
  }
  const causeWeights: Record<HardToAnalyzeCause, number> = {} as Record<HardToAnalyzeCause, number>;
  for (const cause of CAUSE_ORDER) {
    causeWeights[cause] = (causeCounts[cause] ?? 0) / causeTotal;
  }
  const biases: Record<RiskType, number> = {} as Record<RiskType, number>;
  const scoreWeights: Record<RiskType, number> = {} as Record<RiskType, number>;
  const calibration: Record<RiskType, { readonly slope: number; readonly intercept: number }> =
    {} as Record<RiskType, { readonly slope: number; readonly intercept: number }>;
  for (const risk of RISK_ORDER) {
    biases[risk] = -((negatives[risk] ?? 0) / (positives[risk] ?? 1));
    scoreWeights[risk] = (riskShares[risk] ?? 0) / shareTotal;
    calibration[risk] = { slope: PLACEHOLDER_SLOPE, intercept: PLACEHOLDER_INTERCEPT };
  }

  const parsed = parseModelArtifact({
    biases,
    calibration,
    causeWeights,
    scoreWeights,
    severityWeights,
    version: version as string,
  });
  if (!parsed.ok) {
    return invalidArtifact(`trained artifact is not a valid model artifact: ${parsed.error.message}`);
  }
  return ok(Object.freeze({ artifact: parsed.value, dataVersion, seed }));
}

// Freeze the trained values to the exact file bytes: canonical JSON of the
// envelope holding the artifact, its SHA-256 checksum, the training data
// version and the locked seed. The returned text is the whole file content
// with no trailing newline, so writing it verbatim reproduces these bytes.
export function freezeArtifactFile(trained: TrainedArtifact): Result<string, DomainError> {
  const checksum = checksumForArtifact(trained.artifact);
  if (!checksum.ok) {
    return checksum;
  }
  return ok(
    canonicalSerialize({
      artifact: artifactToCanonical(trained.artifact),
      checksum: checksum.value as string,
      dataVersion: trained.dataVersion,
      seed: trained.seed,
    }),
  );
}

// Verify a parsed frozen file: shape, artifact validity and checksum match.
// A changed byte gives the checksum-mismatch branch, so scoring refuses the
// file through ModelArtifactPort (H-11, M-17).
export function verifyArtifactFile(input: unknown): Result<VerifiedArtifact, ArtifactVerificationError> {
  if (!isRecord(input)) {
    return malformed("frozen artifact must be an object");
  }
  const topKeys = Object.keys(input).sort();
  const expectedTop = ["artifact", "checksum", "dataVersion", "seed"].sort();
  if (topKeys.length !== expectedTop.length || topKeys.some((key, index) => key !== expectedTop[index])) {
    return malformed("frozen artifact must carry exactly artifact, checksum, dataVersion and seed");
  }
  const checksumRaw = input["checksum"];
  if (typeof checksumRaw !== "string") {
    return malformed("frozen artifact checksum must be 64 hex characters");
  }
  const checksum = ArtifactChecksum.parse(checksumRaw);
  if (!checksum.ok) {
    return malformed("frozen artifact checksum must be 64 hex characters");
  }
  const dataVersion = input["dataVersion"];
  if (typeof dataVersion !== "string" || dataVersion.length === 0) {
    return malformed("frozen artifact dataVersion must be a non-empty string");
  }
  const seed = input["seed"];
  if (typeof seed !== "number" || !Number.isInteger(seed) || seed < 0) {
    return malformed("frozen artifact seed must be an integer at least 0");
  }
  const parsed = parseModelArtifact(input["artifact"]);
  if (!parsed.ok) {
    return malformed(`frozen artifact holds no valid model artifact: ${parsed.error.message}`);
  }
  const recomputed = checksumForArtifact(parsed.value);
  if (!recomputed.ok) {
    return malformed(`frozen artifact checksum cannot be recomputed: ${recomputed.error.message}`);
  }
  if ((recomputed.value as string) !== (checksum.value as string)) {
    return err({
      kind: "checksum-mismatch",
      message: "frozen artifact checksum mismatch: the file differs from its recorded checksum",
    });
  }
  return ok(Object.freeze({ artifact: parsed.value, checksum: checksum.value, dataVersion, seed }));
}
