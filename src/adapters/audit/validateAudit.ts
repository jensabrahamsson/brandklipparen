// Validation of plugin audit provider output (S-054, K-516, P-14, M-26).
// Pure function shared by the hosted adapter and the fake: strict key
// sets at every level, closed severity and category enums, capped text,
// confidence in [0, 1], and identity match on provider, model, plugin id,
// plugin version and prompt version. Schema-invalid, oversize or
// identity-mismatched output is discarded whole with no partial findings
// salvaged. No message carries response content, so hostile strings never
// leak into logs.
import { err, ok } from "../../domain/result.ts";
import type { Result } from "../../domain/result.ts";
import type { ModelId as ModelIdType } from "../../domain/types.ts";
import type {
  PluginAuditCategory,
  PluginAuditFinding,
  PluginAuditInput,
  PluginAuditModelError,
  PluginAuditReport,
  PluginAuditSeverity,
} from "../../ports/pluginAuditModel.ts";

export type PluginAuditExpectation = {
  readonly provider: "hosted-open-weights";
  readonly modelId: ModelIdType;
  readonly maxOutputChars: number;
};

export const DEFAULT_AUDIT_MAX_OUTPUT_CHARS = 4000;
export const MAX_AUDIT_FINDINGS = 32;
const MAX_LOCATION_CHARS = 256;
const MAX_RATIONALE_CHARS = 2000;
const MAX_EVIDENCE_CHARS = 2000;

const TOP_LEVEL_KEYS: readonly string[] = Object.freeze([
  "findings",
  "modelId",
  "pluginId",
  "pluginVersion",
  "promptVersion",
  "provider",
]);

const FINDING_KEYS: readonly string[] = Object.freeze([
  "category",
  "confidence",
  "location",
  "quotedEvidence",
  "rationale",
  "severity",
]);

const SEVERITIES: readonly string[] = Object.freeze(["info", "low", "medium", "high"]);
const CATEGORIES: readonly string[] = Object.freeze([
  "forbidden-capability",
  "injection-surface",
  "determinism",
  "evidence-integrity",
  "docs-drift",
  "other",
]);

function hasExactlyKeys(record: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(record).sort();
  if (actual.length !== expected.length) {
    return false;
  }
  const wanted = expected.slice().sort();
  for (let index = 0; index < actual.length; index += 1) {
    if (actual[index] !== wanted[index]) {
      return false;
    }
  }
  return true;
}

function invalid(message: string): PluginAuditModelError {
  return { kind: "invalid-output", message };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isSeverity(value: unknown): value is PluginAuditSeverity {
  return typeof value === "string" && SEVERITIES.includes(value);
}

function isCategory(value: unknown): value is PluginAuditCategory {
  return typeof value === "string" && CATEGORIES.includes(value);
}

function cappedText(value: unknown, limit: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= limit;
}

// Plain-check smart constructor for the audit report (P-14): the
// TypeScript types are normative, this function enforces them at the
// boundary with no schema library. The JSON Schema descriptor beside it
// (`PLUGIN_AUDIT_REPORT_SCHEMA`) agrees on frozen examples in both
// directions per the contract check in `tests/unit/plugins/audit.test.ts`.
export function parsePluginAuditReport(
  raw: unknown,
  input: PluginAuditInput,
  expectation: PluginAuditExpectation,
): Result<PluginAuditReport, PluginAuditModelError> {
  if (!isRecord(raw)) {
    return err(invalid("audit response must be a JSON object"));
  }
  if (!hasExactlyKeys(raw, TOP_LEVEL_KEYS)) {
    return err(invalid("audit response carries unexpected top-level keys"));
  }
  if (raw["provider"] !== expectation.provider) {
    return err({ kind: "provider-mismatch", message: "audit provider mismatch" });
  }
  if (raw["modelId"] !== (expectation.modelId as string)) {
    return err({ kind: "provider-mismatch", message: "audit model id mismatch" });
  }
  if (raw["pluginId"] !== input.pluginId || raw["pluginVersion"] !== input.pluginVersion) {
    return err(invalid("audit response names a different plugin"));
  }
  if (raw["promptVersion"] !== (input.promptVersion as string)) {
    return err(invalid("audit response names a different prompt version"));
  }
  const findings = raw["findings"];
  if (!Array.isArray(findings) || findings.length > MAX_AUDIT_FINDINGS) {
    return err(invalid("audit findings must be a bounded list"));
  }
  const checked: PluginAuditFinding[] = [];
  for (const entry of findings) {
    if (!isRecord(entry) || !hasExactlyKeys(entry, FINDING_KEYS)) {
      return err(invalid("audit finding carries unexpected keys"));
    }
    if (!isSeverity(entry["severity"]) || !isCategory(entry["category"])) {
      return err(invalid("audit finding uses an open severity or category"));
    }
    if (!cappedText(entry["location"], MAX_LOCATION_CHARS)) {
      return err(invalid("audit finding needs a short location"));
    }
    if (!cappedText(entry["rationale"], MAX_RATIONALE_CHARS)) {
      return err(invalid("audit finding needs a capped rationale"));
    }
    if (!cappedText(entry["quotedEvidence"], MAX_EVIDENCE_CHARS)) {
      return err(invalid("audit finding needs capped quoted evidence"));
    }
    const confidence = entry["confidence"];
    if (typeof confidence !== "number" || !Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
      return err(invalid("audit finding confidence must lie in [0, 1]"));
    }
    checked.push({
      severity: entry["severity"],
      location: entry["location"],
      category: entry["category"],
      rationale: entry["rationale"],
      confidence,
      quotedEvidence: entry["quotedEvidence"],
    });
  }
  return ok({
    pluginId: input.pluginId,
    pluginVersion: input.pluginVersion,
    promptVersion: input.promptVersion,
    provider: expectation.provider,
    modelId: expectation.modelId,
    findings: Object.freeze(checked),
  });
}

// JSON Schema descriptor (draft-07 subset) beside the normative types
// (P-14): plain checks plus this descriptor, no schema library.
export const PLUGIN_AUDIT_REPORT_SCHEMA = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: Object.freeze(["findings", "modelId", "pluginId", "pluginVersion", "promptVersion", "provider"]),
  properties: Object.freeze({
    findings: Object.freeze({
      type: "array",
      maxItems: MAX_AUDIT_FINDINGS,
      items: Object.freeze({
        type: "object",
        additionalProperties: false,
        required: Object.freeze(["category", "confidence", "location", "quotedEvidence", "rationale", "severity"]),
        properties: Object.freeze({
          category: Object.freeze({ enum: CATEGORIES }),
          confidence: Object.freeze({ type: "number", minimum: 0, maximum: 1 }),
          location: Object.freeze({ type: "string", minLength: 1, maxLength: MAX_LOCATION_CHARS }),
          quotedEvidence: Object.freeze({ type: "string", minLength: 1, maxLength: MAX_EVIDENCE_CHARS }),
          rationale: Object.freeze({ type: "string", minLength: 1, maxLength: MAX_RATIONALE_CHARS }),
          severity: Object.freeze({ enum: SEVERITIES }),
        }),
      }),
    }),
    modelId: Object.freeze({ type: "string", minLength: 1 }),
    pluginId: Object.freeze({ type: "string", minLength: 1 }),
    pluginVersion: Object.freeze({ type: "string", minLength: 1 }),
    promptVersion: Object.freeze({ type: "string", minLength: 1 }),
    provider: Object.freeze({ const: "hosted-open-weights" }),
  }),
});
