// Boundary check for cache entries at read and at write (A-16, K-511,
// M-14). The adapter stores untrusted bytes under each key: a restored
// snapshot, a volume file or a drill injection can carry truncated,
// mistyped or impersonating entries, so every read validates the shape
// and the key binding before the value moves on. A valid entry repeats
// the code hash and model version from its key, so an entry stored under
// another key is rejected as corrupt. Pure module: no I/O, no clock.
import { err, ok } from "../../domain/result.ts";
import type { Result } from "../../domain/result.ts";
import type { CacheError, CachedAssessment } from "../../ports/cache.ts";
import type { CacheKey as CacheKeyType } from "../../domain/types.ts";
import { ANALYSIS_CACHE_VERSION } from "../../domain/types.ts";

function corrupt(message: string): Result<never, CacheError> {
  return err({ kind: "entry-corrupt", message });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function field(holder: Record<string, unknown>, name: string): unknown {
  return holder[name];
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function checkString(holder: Record<string, unknown>, name: string): boolean {
  return isNonEmptyString(field(holder, name));
}

function checkNumber(holder: Record<string, unknown>, name: string): boolean {
  const value = field(holder, name);
  return typeof value === "number" && Number.isFinite(value);
}

// Code hash part of a cache key: 0x plus 64 hex characters (A-10).
function isCodeHashText(value: unknown): value is string {
  if (typeof value !== "string" || value.length !== 66) {
    return false;
  }
  if (!value.startsWith("0x")) {
    return false;
  }
  for (let i = 2; i < 66; i += 1) {
    const code = value.charCodeAt(i);
    const digit = code >= 48 && code <= 57;
    const lower = code >= 97 && code <= 102;
    const upper = code >= 65 && code <= 70;
    if (!digit && !lower && !upper) {
      return false;
    }
  }
  return true;
}

// Splits a cache key into its code hash, model version and engine
// version parts. The key shape is `${codeHash}:${modelVersion}:${engine}`
// from CacheKey.of; no part carries a colon, so exactly two separators
// are expected. A two-part legacy key (or any other shape) is rejected,
// so entries stored before engine versioning never serve (C-16r).
function splitKey(key: CacheKeyType): { codeHash: string; version: string } | null {
  const text = key as string;
  const parts = text.split(":");
  if (parts.length !== 3) {
    return null;
  }
  const [codeHash, version, engine] = parts as unknown as readonly [string, string, string];
  if (!isCodeHashText(codeHash) || version.length === 0 || engine !== ANALYSIS_CACHE_VERSION) {
    return null;
  }
  return { codeHash, version };
}

const RISKS: readonly string[] = Object.freeze(["rug-pull", "honeypot", "bot-pump"]);
const SIGNAL_KINDS: readonly string[] = Object.freeze(["capability", "clone-match", "hard-to-analyze"]);

function checkProbabilities(value: unknown): boolean {
  if (!isRecord(value)) {
    return false;
  }
  const keys = Object.keys(value);
  if (keys.length !== RISKS.length || !RISKS.every((risk) => keys.includes(risk))) {
    return false;
  }
  return RISKS.every((risk) => {
    const entry = value[risk];
    return typeof entry === "number" && Number.isFinite(entry) && entry >= 0 && entry <= 1;
  });
}

function checkEvidenceEntry(value: unknown): boolean {
  if (!isRecord(value)) {
    return false;
  }
  if (!checkString(value, "selector")) {
    return false;
  }
  const offset = field(value, "offset");
  return offset === undefined || offset === null || (typeof offset === "number" && Number.isInteger(offset));
}

function checkSignal(value: unknown): boolean {
  if (!isRecord(value)) {
    return false;
  }
  const kind = field(value, "kind");
  if (typeof kind !== "string" || !SIGNAL_KINDS.includes(kind)) {
    return false;
  }
  if (!checkString(value, "id")) {
    return false;
  }
  const risk = field(value, "risk");
  if (typeof risk !== "string" || !RISKS.includes(risk)) {
    return false;
  }
  const evidence = field(value, "evidence");
  if (!Array.isArray(evidence) || evidence.length === 0 || !evidence.every(checkEvidenceEntry)) {
    return false;
  }
  if (kind === "capability" || kind === "clone-match") {
    const direction = field(value, "direction");
    if (direction !== "raises" && direction !== "lowers") {
      return false;
    }
    const severity = field(value, "severity");
    if (severity !== "low" && severity !== "medium" && severity !== "high") {
      return false;
    }
  }
  if (kind === "clone-match") {
    if (!checkNumber(value, "similarity") || !checkString(value, "group")) {
      return false;
    }
    const priorCount = field(value, "priorCount");
    if (typeof priorCount !== "number" || !Number.isInteger(priorCount) || priorCount < 0) {
      return false;
    }
  }
  if (kind === "hard-to-analyze") {
    const cause = field(value, "cause");
    if (
      cause !== "timeout" &&
      cause !== "resource-limit" &&
      cause !== "decompiler-error" &&
      cause !== "obfuscated-structure"
    ) {
      return false;
    }
  }
  return true;
}

function checkClaim(value: unknown): boolean {
  if (!isRecord(value)) {
    return false;
  }
  if (!checkString(value, "text")) {
    return false;
  }
  const links = field(value, "signalLinks");
  return (
    Array.isArray(links) &&
    links.length > 0 &&
    links.every((link): link is string => isNonEmptyString(link))
  );
}

function checkExplanation(value: unknown): boolean {
  if (!isRecord(value)) {
    return false;
  }
  if (field(value, "kind") !== "template") {
    return false;
  }
  if (!checkString(value, "templateVersion")) {
    return false;
  }
  const claims = field(value, "claims");
  return Array.isArray(claims) && claims.every(checkClaim);
}

const PLUGIN_OUTCOMES: readonly string[] = Object.freeze([
  "ok",
  "invalid-output",
  "threw",
  "timeout",
  "input-unavailable",
]);

function checkPluginFinding(value: unknown): boolean {
  if (!isRecord(value)) {
    return false;
  }
  if (!checkString(value, "id") || !checkString(value, "pluginId") || !checkString(value, "title")) {
    return false;
  }
  const evidence = field(value, "evidence");
  return Array.isArray(evidence) && evidence.length > 0 && evidence.every(checkEvidenceEntry);
}

function checkPluginResult(value: unknown): boolean {
  if (!isRecord(value)) {
    return false;
  }
  if (!checkString(value, "pluginId") || !checkString(value, "pluginVersion")) {
    return false;
  }
  const outcome = field(value, "outcome");
  if (typeof outcome !== "string" || !PLUGIN_OUTCOMES.includes(outcome)) {
    return false;
  }
  const findings = field(value, "findings");
  return Array.isArray(findings) && findings.every(checkPluginFinding);
}

function checkCantTell(value: unknown): boolean {
  if (!Array.isArray(value)) {
    return false;
  }
  return value.every(
    (item): boolean =>
      isRecord(item) && checkString(item, "question") && checkString(item, "dataSource"),
  );
}

// Boundary check for one stored entry under its key. Total: any unknown
// input gives a typed entry-corrupt error, never an exception; a valid
// entry passes through unchanged and the input is never mutated.
export function validateCacheEntry(
  key: CacheKeyType,
  raw: unknown,
): Result<CachedAssessment, CacheError> {
  const parts = splitKey(key);
  if (parts === null) {
    return corrupt(`cache key has an unexpected shape: ${key as string}`);
  }
  if (!isRecord(raw)) {
    return corrupt("cache entry must be an object");
  }
  if (field(raw, "kind") !== "assessed") {
    return corrupt("cache entry must carry kind assessed");
  }
  for (const name of ["codeHash", "modelVersion", "artifactChecksum", "indexVersion", "templateVersion"] as const) {
    if (!checkString(raw, name)) {
      return corrupt(`cache entry must carry ${name} as text`);
    }
  }
  const score = field(raw, "score");
  if (typeof score !== "number" || !Number.isInteger(score) || score < 0 || score > 100) {
    return corrupt("cache entry score must be an integer in [0, 100]");
  }
  if (!checkProbabilities(field(raw, "probabilities"))) {
    return corrupt("cache entry must carry probabilities per risk type in [0, 1]");
  }
  const signals = field(raw, "signals");
  if (!Array.isArray(signals) || !signals.every(checkSignal)) {
    return corrupt("cache entry must carry a signal list with selector evidence");
  }
  if (!checkExplanation(field(raw, "explanation"))) {
    return corrupt("cache entry must carry a template explanation with claim links");
  }
  if (!checkCantTell(field(raw, "cantTell"))) {
    return corrupt("cache entry must carry a cant-tell list with data sources");
  }
  // Additive plugin results (S-043, P-11): the entry carries one outcome
  // record per registered detector plugin beside the calibrated signals.
  const pluginResults = field(raw, "pluginResults");
  if (!Array.isArray(pluginResults) || !pluginResults.every(checkPluginResult)) {
    return corrupt("cache entry must carry a plugin result list with plugin outcomes");
  }
  // Key binding (M-14): the entry repeats its key, so an entry stored
  // under another code hash or model version is rejected as corrupt.
  if ((field(raw, "codeHash") as string) !== parts.codeHash) {
    return corrupt("cache entry code hash does not match its key");
  }
  if ((field(raw, "modelVersion") as string) !== parts.version) {
    return corrupt("cache entry model version does not match its key");
  }
  return ok(raw as CachedAssessment);
}

