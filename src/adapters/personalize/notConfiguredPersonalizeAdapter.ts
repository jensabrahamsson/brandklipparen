// Not-configured personalize adapter for the Meta Model API provider
// (S-069, K-519, P-27). Bound when the key, model id or endpoint is
// absent: every call answers `not-configured` with zero sends and the
// deterministic baseline stands. This module also carries the shared
// personalize response validation used by the Meta adapter.
import { err, ok } from "../../domain/result.ts";
import type { Result } from "../../domain/result.ts";
import { parsePersonalizeSpec } from "../../plugins/personalizeSpec.ts";
import type { PersonalizeSpec } from "../../plugins/personalizeSpec.ts";
import type {
  PersonalizeInput,
  PluginPersonalizeModelError,
  PluginPersonalizeModelPort,
  PluginPersonalizeProvider,
} from "../../ports/pluginPersonalizeModel.ts";
import type { ModelId as ModelIdType } from "../../domain/types.ts";

export const META_PERSONALIZE_MODEL_ID = "meta-models/muse-spark-open-1026";

export type PersonalizeLogEntry = {
  readonly requestId: string;
  readonly codeHash: string;
  readonly promptVersion: string;
  readonly provider: PluginPersonalizeProvider;
  readonly modelId: string;
  readonly outcome: PluginPersonalizeModelError["kind"] | "ok";
};

export class NotConfiguredPersonalizeAdapter implements PluginPersonalizeModelPort {
  private readonly modelIdValue: ModelIdType | undefined;

  constructor(modelId?: ModelIdType | undefined) {
    this.modelIdValue = modelId;
  }

  provider(): "meta-model-api" {
    return "meta-model-api";
  }

  modelId(): ModelIdType {
    return (this.modelIdValue ?? META_PERSONALIZE_MODEL_ID) as ModelIdType;
  }

  async personalize(): Promise<Result<PersonalizeSpec, PluginPersonalizeModelError>> {
    return err({
      kind: "not-configured",
      message: "AI personalize is not configured: set the assessment meta key and model",
    });
  }
}

function byteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

export function parsePersonalizeResponse(
  bodyText: string,
  input: PersonalizeInput,
  expected: { provider: PluginPersonalizeProvider; modelId: ModelIdType; maxOutputChars: number },
): Result<PersonalizeSpec, PluginPersonalizeModelError> {
  let raw: unknown;
  try {
    raw = JSON.parse(bodyText) as unknown;
  } catch {
    return err({ kind: "invalid-output", message: "personalize response is not valid JSON" });
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return err({ kind: "invalid-output", message: "personalize response must be an object" });
  }
  const record = raw as Record<string, unknown>;
  if (record["provider"] !== expected.provider || String(record["modelId"]) !== (expected.modelId as string)) {
    return err({ kind: "provider-mismatch", message: "personalize response names another provider or model" });
  }
  const specText = JSON.stringify(record["spec"] ?? null);
  if (byteLength(specText) > expected.maxOutputChars) {
    return err({
      kind: "output-too-large",
      message: "personalize response exceeds the output size limit",
      limitChars: expected.maxOutputChars,
    });
  }
  const checked = parsePersonalizeSpec(record["spec"], {
    sectionIds: input.sectionIds,
    pluginIds: input.pluginIds,
    flooredSectionIds: input.flooredSectionIds,
    maxPlacements: 16,
    maxRanking: 16,
  });
  if (!checked.ok) {
    return err({ kind: "invalid-output", message: `personalize response fails spec validation: ${checked.error.message}` });
  }
  return ok(checked.value);
}

export function classifyPersonalizeSpecCheck(message: string): string {
  if (message.includes("names a plugin absent from the request")) {
    return "unknown-plugin";
  }
  if (message.includes("names an unknown section id")) {
    return "unknown-section";
  }
  if (
    message.includes("must not collapse a floored section") ||
    message.includes("always include score and explanation") ||
    message.includes("always include summary and score")
  ) {
    return "floor-violated";
  }
  if (message.includes("forbids the field")) {
    return "unknown-field";
  }
  if (message.includes("repeats a plugin id") || message.includes("repeats a section id")) {
    return "duplicate-id";
  }
  if (message.includes("exceeds the size bound")) {
    return "oversize";
  }
  return "missing-field";
}

export function classifyPersonalizeValidationCheck(error: { kind: string; message: string }): string {
  if (error.kind === "provider-mismatch") {
    return "provider-echo";
  }
  if (error.message === "personalize response is not valid JSON") {
    return "not-json";
  }
  if (error.message === "personalize response must be an object") {
    return "missing-field";
  }
  return classifyPersonalizeSpecCheck(error.message);
}
