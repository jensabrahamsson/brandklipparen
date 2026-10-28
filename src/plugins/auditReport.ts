// Stored CI audit report read view (S-058, K-516, P-13, P-16 outline).
// Pure value module: the CLI/CI writes one report JSON per plugin under
// `audits/<pluginId>.json`, and the REST and MCP read views serve that
// stored record. This module owns the stored shape, its validation and
// its single serialisation path, so REST and MCP carry byte-identical
// bodies for the same record (K-027). The read view never triggers an
// audit and never changes registration, scores or evidence: a clean AI
// report alone registers no plugin.
import { canonicalSerialize } from "../domain/serialize.ts";
import type { CanonicalValue } from "../domain/serialize.ts";

export type StoredAuditDeterministic =
  | { readonly kind: "pass" }
  | {
      readonly kind: "fail";
      readonly failures: readonly { readonly kind: string; readonly message: string }[];
    };

export type StoredAuditFinding = {
  readonly severity: string;
  readonly location: string;
  readonly category: string;
  readonly rationale: string;
};

export type StoredAuditAi =
  | { readonly kind: "not-run" }
  | { readonly kind: "not-configured" }
  | { readonly kind: "invalid-output" }
  | {
      readonly kind: "advisory";
      readonly findings: readonly StoredAuditFinding[];
      readonly provider: string;
      readonly modelId: string;
    };

export type StoredAuditReport = {
  readonly pluginId: string;
  readonly version: string;
  readonly deterministic: StoredAuditDeterministic;
  readonly ai: StoredAuditAi;
  readonly humanReview: "recorded" | "missing";
};

export type StoredAuditReportMap = ReadonlyMap<string, StoredAuditReport>;

// Single serialisation path for one stored report: plugin id, version and
// the three separate states (deterministic, ai, human-review) with the
// provider and model id on the advisory branch, so no single line reads
// as an approval on its own (P-13).
export function serializeStoredAuditReport(report: StoredAuditReport): string {
  return canonicalSerialize({
    ai: report.ai,
    deterministic: report.deterministic,
    humanReview: report.humanReview,
    pluginId: report.pluginId,
    version: report.version,
  } as { readonly [key: string]: CanonicalValue });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Plain-check smart constructor for a stored report file: rejects unknown
// shapes, unknown state kinds and oversize text before any surface serves
// the record. Never throws.
export function parseStoredAuditReport(
  value: unknown,
): { readonly ok: true; readonly value: StoredAuditReport } | { readonly ok: false; readonly message: string } {
  if (!isRecord(value)) {
    return { ok: false, message: "stored audit report must be an object" };
  }
  const pluginId = value["pluginId"];
  const version = value["version"];
  if (typeof pluginId !== "string" || pluginId.length < 1 || pluginId.length > 256) {
    return { ok: false, message: "stored audit report carries an invalid plugin id" };
  }
  if (typeof version !== "string" || version.length < 1 || version.length > 32) {
    return { ok: false, message: "stored audit report carries an invalid version" };
  }
  const deterministic = value["deterministic"];
  if (!isRecord(deterministic) || (deterministic["kind"] !== "pass" && deterministic["kind"] !== "fail")) {
    return { ok: false, message: "stored audit report carries an invalid deterministic state" };
  }
  if (deterministic["kind"] === "fail" && !Array.isArray(deterministic["failures"])) {
    return { ok: false, message: "stored audit report carries an invalid failure list" };
  }
  const ai = value["ai"];
  if (!isRecord(ai) || typeof ai["kind"] !== "string") {
    return { ok: false, message: "stored audit report carries an invalid ai state" };
  }
  if (
    ai["kind"] !== "not-run" &&
    ai["kind"] !== "not-configured" &&
    ai["kind"] !== "invalid-output" &&
    ai["kind"] !== "advisory"
  ) {
    return { ok: false, message: "stored audit report carries an unknown ai state" };
  }
  if (ai["kind"] === "advisory") {
    if (typeof ai["provider"] !== "string" || typeof ai["modelId"] !== "string" || !Array.isArray(ai["findings"])) {
      return { ok: false, message: "stored audit report carries an invalid advisory finding list" };
    }
  }
  const humanReview = value["humanReview"];
  if (humanReview !== "recorded" && humanReview !== "missing") {
    return { ok: false, message: "stored audit report carries an invalid human-review state" };
  }
  const report: StoredAuditReport = Object.freeze({
    pluginId,
    version,
    deterministic: Object.freeze({ ...deterministic }) as StoredAuditDeterministic,
    ai: Object.freeze({ ...(ai as Record<string, unknown>) }) as StoredAuditAi,
    humanReview,
  });
  return { ok: true, value: report };
}
