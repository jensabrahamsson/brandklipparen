// Validation of investigation provider output (S-073, K-036, K-520,
// K-513, P-38). Pure function shared by the Meta adapter and the fake:
// strict key sets at every level, provider and model id matched exactly,
// rationale and draft length-capped. Every rejection keeps the
// deterministic analysis standing; no message carries response content,
// so hostile strings never leak into logs.
import { err, ok } from "../../domain/result.ts";
import type { Result } from "../../domain/result.ts";
import type { ModelId as ModelIdType } from "../../domain/types.ts";
import type {
  InvestigationDecision,
  InvestigationModelError,
  InvestigationProvider,
} from "../../ports/investigationModel.ts";

export type InvestigationExpectation = {
  readonly provider: InvestigationProvider;
  readonly modelId: ModelIdType;
  readonly maxOutputChars: number;
};

export const DEFAULT_INVESTIGATION_MAX_OUTPUT_CHARS = 4000;
const MAX_TOOL_ID_CHARS = 128;
const MAX_RATIONALE_CHARS = 2000;

const TOP_LEVEL_KEYS: readonly string[] = Object.freeze(["decision", "modelId", "provider"]);
const RUN_TOOL_KEYS: readonly string[] = Object.freeze(["args", "kind", "rationale", "toolId"]);
const CONCLUDE_KEYS: readonly string[] = Object.freeze(["kind", "narrativeDraft", "rationale"]);

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

function invalid(message: string): InvestigationModelError {
  return { kind: "invalid-output", message };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isArgsRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return isRecord(value);
}

export function validateInvestigationDecision(
  raw: unknown,
  expectation: InvestigationExpectation,
): Result<InvestigationDecision, InvestigationModelError> {
  if (!isRecord(raw)) {
    return err(invalid("investigation response must be a JSON object"));
  }
  if (!hasExactlyKeys(raw, TOP_LEVEL_KEYS)) {
    return err(invalid("investigation response carries unexpected top-level keys"));
  }
  if (raw["provider"] !== expectation.provider) {
    return err({ kind: "provider-mismatch", message: "investigation provider mismatch" });
  }
  if (raw["modelId"] !== (expectation.modelId as string)) {
    return err({ kind: "provider-mismatch", message: "investigation model id mismatch" });
  }
  const decision = raw["decision"];
  if (!isRecord(decision)) {
    return err(invalid("investigation decision must be an object"));
  }
  if (decision["kind"] === "run-tool") {
    if (!hasExactlyKeys(decision, RUN_TOOL_KEYS)) {
      return err(invalid("run-tool decision carries unexpected keys"));
    }
    const toolId = decision["toolId"];
    const rationale = decision["rationale"];
    const args = decision["args"];
    if (typeof toolId !== "string" || toolId.length === 0 || toolId.length > MAX_TOOL_ID_CHARS) {
      return err(invalid("run-tool decision needs a short tool id"));
    }
    if (typeof rationale !== "string" || rationale.length === 0 || rationale.length > MAX_RATIONALE_CHARS) {
      return err(invalid("run-tool decision needs a capped rationale"));
    }
    if (!isArgsRecord(args)) {
      return err(invalid("run-tool decision args must be an object"));
    }
    return ok({ kind: "run-tool", toolId, args, rationale });
  }
  if (decision["kind"] === "conclude") {
    if (!hasExactlyKeys(decision, CONCLUDE_KEYS)) {
      return err(invalid("conclude decision carries unexpected keys"));
    }
    const draft = decision["narrativeDraft"];
    if (typeof draft !== "string" || draft.length === 0 || draft.length > expectation.maxOutputChars) {
      return err(invalid("conclude decision needs a capped narrative draft"));
    }
    const conclusion = decision["rationale"];
    if (typeof conclusion !== "string" || conclusion.length === 0 || conclusion.length > MAX_RATIONALE_CHARS) {
      return err(invalid("conclude decision needs a capped rationale"));
    }
    return ok({ kind: "conclude", narrativeDraft: draft, rationale: conclusion });
  }
  return err(invalid("investigation decision kind is unknown"));
}
