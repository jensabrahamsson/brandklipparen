// Risk model with calibrated probabilities and 0-100 score (K-011, S-020).
// Pure domain module: every model value (severity and cause weights, biases,
// calibration slopes and intercepts, score weights) arrives through the
// ModelArtifact parameter validated by parseModelArtifact. This module carries
// no learned numbers of its own: the named numeric constants below steer
// arithmetic only (sigmoid input guard, unit-interval clamp, 0-100 scale).
// The function score() has the signature in A-19 and runs in a fixed order of
// operations: signals sort on a canonical key before accumulation, per-risk
// loops follow one fixed risk order, and probabilities round through
// Probability.ofRounded before storage, so equal inputs give bit-identical
// output on every platform (A-32).
import { ModelVersion, Probability, RiskScore } from "./types.ts";
import type {
  DomainError,
  ModelVersion as ModelVersionType,
  Probability as ProbabilityType,
  RiskScore as RiskScoreType,
  SignalId as SignalIdType,
} from "./types.ts";
import { err, ok } from "./result.ts";
import type { Result } from "./result.ts";
import type {
  Direction,
  HardToAnalyzeCause,
  RiskType,
  Severity,
  Signal,
} from "./signals.ts";

// Fixed risk order for every per-risk loop (lexicographic).
const RISK_ORDER: readonly RiskType[] = Object.freeze(["bot-pump", "honeypot", "rug-pull"]);

const SEVERITY_KEYS: readonly Severity[] = Object.freeze(["low", "medium", "high"]);

const CAUSE_KEYS: readonly HardToAnalyzeCause[] = Object.freeze([
  "timeout",
  "resource-limit",
  "decompiler-error",
  "obfuscated-structure",
]);

// Arithmetic guards, not learned values: LOGIT_CLAMP keeps extreme artifact
// weights from overflowing Math.exp (sigmoid saturates past it), and
// SCORE_SCALE maps the clamped unit-interval combination onto 0-100.
const LOGIT_CLAMP = 60;
const SCORE_SCALE = 100;

// Versioned model artifact (A-20, K-210, K-211). Frozen at parse time; the
// values steer score() and are reported through RiskResult.modelVersion.
// `pluginWeights` names the calibrated detector plugins (S-047, P-05): a
// plugin id mapped to its calibrated weight. A plugin the artifact does
// not name carries weight 0 and its findings stay display records; the
// weight is read from the artifact only, never from the manifest or the
// finding, so a plugin cannot raise its own influence.
// `pluginFeatureCatalogue` (S-115) maps an owner-control detector plugin
// id to the risk, direction and severity its `feature` findings convert
// with: the single artifact-carried catalogue the conversion reads, so a
// plugin still cannot steer its own score. Absent entries convert
// nothing; older artifacts carry no entry and verify unchanged.
// `detectorHeadWeights` (S-115 calibration) maps a detector plugin id to
// its fitted weight per risk head: converted signals carrying that plugin
// id score with the head weight instead of the severity weight, so the
// fitted per-plugin magnitudes shape the totals. Absent means every
// signal scores through the severity weights.
export type PluginFeatureMapping = {
  readonly risk: RiskType;
  readonly direction: Direction;
  readonly severity: Severity;
};

export type ScoreBands = {
  readonly elevated: number;
  readonly high: number;
};

// Calibrated per-plugin per-head weights (S-115 calibration): a detector
// plugin id mapped to its fitted weight per risk head. The weights come
// from L2-regularised logistic regression on TRAIN with a non-negative
// constraint for detectors whose documented semantics are risk-increasing,
// followed by a monotone (slope at least 0) Platt map per head. Only the
// fitted rug-pull and honeypot heads carry weights; a missing plugin id or
// head scores through the severity weights. Absent means no detector
// carries a calibrated head weight.
export type CalibratedHead = "rug-pull" | "honeypot";

export type DetectorHeadWeights = Readonly<Record<string, Readonly<Record<CalibratedHead, number>>>>;

export type ModelArtifact = {
  readonly version: ModelVersionType;
  readonly severityWeights: Readonly<Record<Severity, number>>;
  readonly causeWeights: Readonly<Record<HardToAnalyzeCause, number>>;
  readonly biases: Readonly<Record<RiskType, number>>;
  readonly calibration: Readonly<Record<RiskType, CalibrationParams>>;
  readonly scoreWeights: Readonly<Record<RiskType, number>>;
  readonly pluginWeights: Readonly<Record<string, number>>;
  readonly pluginFeatureCatalogue: Readonly<Record<string, PluginFeatureMapping>>;
  readonly detectorHeadWeights?: DetectorHeadWeights | undefined;
  readonly scoreBands?: ScoreBands | undefined;
  readonly uncalibratedHeads?: readonly RiskType[] | undefined;
};

export type CalibrationParams = {
  readonly slope: number;
  readonly intercept: number;
};

export type SignalContribution = {
  readonly signalId: SignalIdType;
  readonly risk: RiskType;
  readonly direction: Direction;
  readonly weight: number;
};

export type RiskProbabilities = Readonly<Record<RiskType, ProbabilityType>>;

export type RiskResult = {
  readonly probabilities: RiskProbabilities;
  readonly score: RiskScoreType;
  readonly modelVersion: ModelVersionType;
  readonly contributions: readonly SignalContribution[];
};

function invalidArtifact(message: string): Result<never, DomainError> {
  return err({ kind: "invalid-model-artifact", message });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function readTable<Kind extends string>(
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
    if (!isFiniteNumber(value)) {
      return null;
    }
    out[key] = value;
  }
  return out;
}

// Pure validating parser for the versioned model artifact. Unknown input
// gives a typed invalid-model-artifact error; valid input gives a deeply
// frozen artifact. Extra keys are rejected so a misspelled field cannot pass
// silently. `pluginWeights` is optional for older files and defaults to the
// empty mapping (weight 0 for every plugin); when present every value must
// be a finite number at least 0 keyed by a non-empty plugin id.
export function parseModelArtifact(input: unknown): Result<ModelArtifact, DomainError> {
  if (!isRecord(input)) {
    return invalidArtifact("model artifact must be an object");
  }
  const topKeys = Object.keys(input).sort();
  const expectedBase = ["biases", "calibration", "causeWeights", "scoreWeights", "severityWeights", "version"].sort();
  const optionalTop = ["pluginWeights", "pluginFeatureCatalogue", "detectorHeadWeights", "scoreBands", "uncalibratedHeads"];
  const matchesExpected =
    expectedBase.every((key) => topKeys.includes(key)) &&
    topKeys.every((key) => expectedBase.includes(key) || optionalTop.includes(key));
  if (!matchesExpected) {
    return invalidArtifact(
      "model artifact must carry exactly version, severityWeights, causeWeights, biases, calibration and scoreWeights with optional pluginWeights, pluginFeatureCatalogue, detectorHeadWeights, scoreBands and uncalibratedHeads",
    );
  }
  if (typeof input["version"] !== "string") {
    return invalidArtifact("model artifact version must be a string");
  }
  const version = ModelVersion.parse(input["version"]);
  if (!version.ok) {
    return invalidArtifact(`model artifact version is not semver: ${input["version"] as string}`);
  }
  const severityWeights = readTable(input, "severityWeights", SEVERITY_KEYS);
  if (severityWeights === null) {
    return invalidArtifact("model artifact severityWeights must map low, medium and high to finite numbers");
  }
  const causeWeights = readTable(input, "causeWeights", CAUSE_KEYS);
  if (causeWeights === null) {
    return invalidArtifact("model artifact causeWeights must map every hard-to-analyze cause to a finite number");
  }
  const biases = readTable(input, "biases", RISK_ORDER);
  if (biases === null) {
    return invalidArtifact("model artifact biases must map every risk type to a finite number");
  }
  const scoreWeights = readTable(input, "scoreWeights", RISK_ORDER);
  if (scoreWeights === null) {
    return invalidArtifact("model artifact scoreWeights must map every risk type to a finite number");
  }
  const rawCalibration = input["calibration"];
  if (!isRecord(rawCalibration) || Object.keys(rawCalibration).length !== RISK_ORDER.length) {
    return invalidArtifact("model artifact calibration must carry params per risk type");
  }
  const calibration = {} as Record<RiskType, CalibrationParams>;
  for (const risk of RISK_ORDER) {
    const entry = rawCalibration[risk];
    if (!isRecord(entry)) {
      return invalidArtifact(`model artifact calibration for ${risk} must be an object`);
    }
    const entryKeys = Object.keys(entry).sort();
    if (entryKeys.length !== 2 || entryKeys[0] !== "intercept" || entryKeys[1] !== "slope") {
      return invalidArtifact(`model artifact calibration for ${risk} must carry exactly slope and intercept`);
    }
    if (!isFiniteNumber(entry["slope"]) || !isFiniteNumber(entry["intercept"])) {
      return invalidArtifact(`model artifact calibration for ${risk} must hold finite numbers`);
    }
    calibration[risk] = Object.freeze({ slope: entry["slope"], intercept: entry["intercept"] });
  }
  const pluginWeights = readPluginWeights(input["pluginWeights"]);
  if (pluginWeights === null) {
    return invalidArtifact("model artifact pluginWeights must map plugin ids to finite numbers at least 0");
  }
  const pluginFeatureCatalogue = readPluginFeatureCatalogue(input["pluginFeatureCatalogue"]);
  if (pluginFeatureCatalogue === null) {
    return invalidArtifact(
      "model artifact pluginFeatureCatalogue must map plugin ids to risk, direction and severity",
    );
  }
  const detectorHeadWeights = readDetectorHeadWeights(input["detectorHeadWeights"]);
  if (detectorHeadWeights === null) {
    return invalidArtifact(
      "model artifact detectorHeadWeights must map plugin ids to finite per-head weights at least 0",
    );
  }
  const scoreBands = readScoreBands(input["scoreBands"]);
  if (scoreBands === null) {
    return invalidArtifact("model artifact scoreBands must carry integer elevated and high cutoffs with elevated below high");
  }
  const uncalibratedHeads = readUncalibratedHeads(input["uncalibratedHeads"]);
  if (uncalibratedHeads === null) {
    return invalidArtifact("model artifact uncalibratedHeads must list known risk types");
  }
  return ok(
    Object.freeze({
      version: version.value,
      severityWeights: Object.freeze(severityWeights),
      causeWeights: Object.freeze(causeWeights),
      biases: Object.freeze(biases),
      calibration: Object.freeze(calibration),
      scoreWeights: Object.freeze(scoreWeights),
      pluginWeights: Object.freeze(pluginWeights),
      pluginFeatureCatalogue: Object.freeze(pluginFeatureCatalogue),
      ...(detectorHeadWeights === undefined ? {} : { detectorHeadWeights: Object.freeze(detectorHeadWeights) }),
      ...(scoreBands === undefined ? {} : { scoreBands: Object.freeze(scoreBands) }),
      ...(uncalibratedHeads === undefined ? {} : { uncalibratedHeads: Object.freeze(uncalibratedHeads) }),
    }),
  );
}

function readPluginWeights(raw: unknown): Record<string, number> | null {
  if (raw === undefined) {
    return {};
  }
  if (!isRecord(raw)) {
    return null;
  }
  const out: Record<string, number> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (key.length === 0 || !isFiniteNumber(value) || value < 0) {
      return null;
    }
    out[key] = value;
  }
  return out;
}

const FEATURE_RISKS: readonly string[] = Object.freeze(["rug-pull", "honeypot", "bot-pump"]);
const FEATURE_DIRECTIONS: readonly string[] = Object.freeze(["raises", "lowers"]);
const FEATURE_SEVERITIES: readonly string[] = Object.freeze(["low", "medium", "high"]);

// Optional score bands (real calibration): integer cutoffs for
// Elevated and High with Elevated below High. Absent means the
// documented 30/60 defaults. Unknown input gives null.
function readScoreBands(raw: unknown): ScoreBands | undefined | null {
  if (raw === undefined) {
    return undefined;
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return null;
  }
  const record = raw as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (keys.length !== 2 || keys[0] !== "elevated" || keys[1] !== "high") {
    return null;
  }
  const elevated = record["elevated"];
  const high = record["high"];
  if (
    typeof elevated !== "number" ||
    typeof high !== "number" ||
    !Number.isInteger(elevated) ||
    !Number.isInteger(high) ||
    elevated < 0 ||
    high < 0 ||
    elevated > 100 ||
    high > 100 ||
    !(elevated < high)
  ) {
    return null;
  }
  return { elevated, high };
}

// Optional uncalibrated heads (real calibration): names risk types with
// no positives in fitting, kept on prior parameters. Absent means every
// head is calibrated. Unknown input gives null.
function readUncalibratedHeads(raw: unknown): readonly RiskType[] | undefined | null {
  if (raw === undefined) {
    return undefined;
  }
  if (!Array.isArray(raw)) {
    return null;
  }
  const seen = new Set<string>();
  for (const entry of raw) {
    if (typeof entry !== "string" || !FEATURE_RISKS.includes(entry) || seen.has(entry)) {
      return null;
    }
    seen.add(entry);
  }
  return Object.freeze([...raw] as RiskType[]);
}

// Optional per-plugin feature catalogue (S-115): absent means no feature
// finding converts. Unknown input gives null; valid input gives the frozen
// mapping keyed by plugin id.
function readPluginFeatureCatalogue(raw: unknown): Record<string, PluginFeatureMapping> | null {
  if (raw === undefined) {
    return {};
  }
  if (!isRecord(raw)) {
    return null;
  }
  const out: Record<string, PluginFeatureMapping> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (key.length === 0 || !isRecord(value)) {
      return null;
    }
    const valueKeys = Object.keys(value).sort();
    if (valueKeys.length !== 3 || valueKeys[0] !== "direction" || valueKeys[1] !== "risk" || valueKeys[2] !== "severity") {
      return null;
    }
    const risk: unknown = value["risk"];
    const direction: unknown = value["direction"];
    const severity: unknown = value["severity"];
    if (
      typeof risk !== "string" ||
      typeof direction !== "string" ||
      typeof severity !== "string" ||
      !FEATURE_RISKS.includes(risk) ||
      !FEATURE_DIRECTIONS.includes(direction) ||
      !FEATURE_SEVERITIES.includes(severity)
    ) {
      return null;
    }
    out[key] = Object.freeze({
      risk: risk as PluginFeatureMapping["risk"],
      direction: direction as PluginFeatureMapping["direction"],
      severity: severity as PluginFeatureMapping["severity"],
    });
  }
  return out;
}

function sigmoid(logit: number): number {
  const clamped = Math.min(LOGIT_CLAMP, Math.max(-LOGIT_CLAMP, logit));
  return 1 / (1 + Math.exp(-clamped));
}

// Probability.ofRounded is infallible for a clamped finite unit-interval
// value; the fallback branch below is unreachable and keeps the function total.
function toProbability(value: number): ProbabilityType {
  const clamped = Math.min(1, Math.max(0, value));
  const parsed = Probability.ofRounded(clamped);
  if (parsed.ok) {
    return parsed.value;
  }
  return 0 as ProbabilityType;
}

// RiskScore.of is infallible for a rounded integer in [0, 100]; the fallback
// branch below is unreachable and keeps the function total.
function toScore(value: number): RiskScoreType {
  const clamped = Math.min(SCORE_SCALE, Math.max(0, Math.round(value)));
  const parsed = RiskScore.of(clamped);
  if (parsed.ok) {
    return parsed.value;
  }
  return 0 as RiskScoreType;
}

// Optional per-plugin per-head weights (S-115 calibration): absent means
// no detector carries a calibrated head weight. When present every plugin
// id maps to finite per-head weights at least 0; unknown input gives null.
function readDetectorHeadWeights(raw: unknown): DetectorHeadWeights | undefined | null {
  if (raw === undefined) {
    return undefined;
  }
  if (!isRecord(raw)) {
    return null;
  }
  const out: Record<string, Record<CalibratedHead, number>> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (key.length === 0 || !isRecord(value)) {
      return null;
    }
    const valueKeys = Object.keys(value).sort();
    if (valueKeys.length !== 2 || valueKeys[0] !== "honeypot" || valueKeys[1] !== "rug-pull") {
      return null;
    }
    const rug = value["rug-pull"];
    const honey = value["honeypot"];
    if (!isFiniteNumber(rug) || rug < 0 || !isFiniteNumber(honey) || honey < 0) {
      return null;
    }
    out[key] = Object.freeze({ "rug-pull": rug, honeypot: honey });
  }
  return out;
}

// Signed contribution of one signal to its own risk bucket. Direction steers
// the sign (raises adds, lowers subtracts); hard-to-analyze signals carry no
// direction and count as raising. Clone-match magnitudes scale with the
// reported similarity. All magnitudes come from the artifact: a capability
// signal converted from a calibrated detector plugin uses the artifact
// per-plugin per-head weight for its risk head, and every other signal
// uses the severity weights.
function contributionOf(signal: Signal, artifact: ModelArtifact): SignalContribution {
  switch (signal.kind) {
    case "capability": {
      const head = signal.risk === "bot-pump" ? undefined : (signal.risk as CalibratedHead);
      const calibrated =
        signal.sourcePlugin === undefined || head === undefined
          ? undefined
          : artifact.detectorHeadWeights?.[signal.sourcePlugin]?.[head];
      const magnitude = calibrated ?? artifact.severityWeights[signal.severity] ?? 0;
      const sign = signal.direction === "raises" ? 1 : -1;
      return { signalId: signal.id, risk: signal.risk, direction: signal.direction, weight: sign * magnitude };
    }
    case "clone-match": {
      const magnitude = (artifact.severityWeights[signal.severity] ?? 0) * (signal.similarity as number);
      const sign = signal.direction === "raises" ? 1 : -1;
      return { signalId: signal.id, risk: signal.risk, direction: signal.direction, weight: sign * magnitude };
    }
    case "hard-to-analyze": {
      const magnitude = artifact.causeWeights[signal.cause] ?? 0;
      return { signalId: signal.id, risk: signal.risk, direction: "raises", weight: magnitude };
    }
  }
}

// Canonical sort key for accumulation order: signal id first, then every
// structural field, so equal keys mean deep-equal contributions and any order
// of equal entries sums identically.
function accumulationKey(signal: Signal): string {
  const id = signal.id as string;
  switch (signal.kind) {
    case "capability":
      return `${id}|capability|${signal.risk}|${signal.direction}|${signal.severity}|${evidenceKey(signal.evidence)}`;
    case "clone-match":
      return `${id}|clone-match|${signal.risk}|${signal.direction}|${signal.severity}|${String(signal.similarity as number)}|${signal.group as string}|${String(signal.priorCount)}|${evidenceKey(signal.evidence)}`;
    case "hard-to-analyze":
      return `${id}|hard-to-analyze|${signal.risk}|${signal.cause}|${evidenceKey(signal.evidence)}`;
  }
}

function evidenceKey(evidence: Signal["evidence"]): string {
  const parts: string[] = [];
  for (const entry of evidence) {
    const offset = entry.offset === undefined ? "none" : String(entry.offset as number);
    parts.push(`${entry.selector as string}:${offset}`);
  }
  return parts.join(",");
}

// The risk model (A-19): calibrated probabilities per risk type, a combined
// 0-100 score and the largest contributions in each direction. Total: any
// signal list and any parsed artifact give a result; probabilities round to
// six decimals and the score rounds to an integer.
export function score(signals: readonly Signal[], artifact: ModelArtifact): RiskResult {
  const ordered = signals.slice();
  ordered.sort((left, right) => {
    const leftKey = accumulationKey(left);
    const rightKey = accumulationKey(right);
    if (leftKey < rightKey) {
      return -1;
    }
    if (leftKey > rightKey) {
      return 1;
    }
    return 0;
  });

  const totals: Record<RiskType, number> = {
    "rug-pull": artifact.biases["rug-pull"] ?? 0,
    honeypot: artifact.biases["honeypot"] ?? 0,
    "bot-pump": artifact.biases["bot-pump"] ?? 0,
  };
  const contributions: SignalContribution[] = [];
  for (const signal of ordered) {
    const entry = contributionOf(signal, artifact);
    totals[entry.risk] = (totals[entry.risk] ?? 0) + entry.weight;
    contributions.push(Object.freeze(entry));
  }

  const probabilities = {} as Record<RiskType, ProbabilityType>;
  for (const risk of RISK_ORDER) {
    const params = artifact.calibration[risk];
    const slope = params?.slope ?? 0;
    const intercept = params?.intercept ?? 0;
    probabilities[risk] = toProbability(sigmoid(slope * (totals[risk] ?? 0) + intercept));
  }

  let weighted = 0;
  let normalizer = 0;
  for (const risk of RISK_ORDER) {
    const weight = artifact.scoreWeights[risk] ?? 0;
    weighted += weight * (probabilities[risk] as number);
    normalizer += Math.abs(weight);
  }
  const combined = normalizer === 0 ? 0 : weighted / normalizer;

  contributions.sort((left, right) => {
    const leftSize = Math.abs(left.weight);
    const rightSize = Math.abs(right.weight);
    if (leftSize > rightSize) {
      return -1;
    }
    if (leftSize < rightSize) {
      return 1;
    }
    const leftId = left.signalId as string;
    const rightId = right.signalId as string;
    if (leftId < rightId) {
      return -1;
    }
    if (leftId > rightId) {
      return 1;
    }
    return 0;
  });

  return Object.freeze({
    probabilities: Object.freeze(probabilities),
    score: toScore(combined * SCORE_SCALE),
    modelVersion: artifact.version,
    contributions: Object.freeze(contributions),
  });
}
