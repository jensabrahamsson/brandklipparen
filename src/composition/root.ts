// Composition root: single wiring module (A-03, K-309).
// This story binds no real provider adapters yet (they arrive in later
// stories); the root resolves the validated configuration to exactly one
// assessment binding, or none when disabled. Invalid or ambiguous selection
// is a typed startup error naming the variable with values kept outside
// the error text (A-15, K-505).
import { err, ok } from "../domain/result.ts";
import type { Result } from "../domain/result.ts";
import { createAppServices } from "../application/analyzeToken.ts";
import type { AnalyzeTokenPorts, AppServices } from "../application/analyzeToken.ts";
import type { AppConfig, ConfigError } from "../ports/config.ts";
import type { ModelId } from "../domain/types.ts";
import type { AssessmentProvider } from "../ports/assessmentModel.ts";

// Single wiring point for the shared application service (A-02, A-03,
// K-027): the root binds each port to exactly one adapter and hands the ready
// AppServices structure to the driving adapters (REST, MCP, web UI) through
// constructor injection. Proxy resolution (S-006) is wired through the same
// structure; just-deployed listing joins it in a later story.
export function wireAppServices(ports: AnalyzeTokenPorts): AppServices {
  return createAppServices(ports);
}

export type AssessmentBinding =
  | { readonly kind: "disabled" }
  | { readonly kind: "enabled"; readonly provider: AssessmentProvider; readonly modelId: ModelId };

export type AssessmentHealthStatus =
  | { readonly provider: AssessmentProvider; readonly modelId: ModelId }
  | { readonly disabled: true };

const PROVIDER_VARIABLE = "BRANDKLIPPAREN_ASSESSMENT_PROVIDER";
const META_MODEL_VARIABLE = "BRANDKLIPPAREN_ASSESSMENT_META_MODEL_ID";
const hosted_MODEL_VARIABLE = "BRANDKLIPPAREN_ASSESSMENT_hosted_MODEL_ID";

function hasProviderCredentials(config: AppConfig): boolean {
  return (
    config.assessmentMetaApiKey !== undefined ||
    config.assessmentMetaModelId !== undefined ||
    config.assessmentMetaBaseUrl !== undefined ||
    config.assessmenthostedApiKey !== undefined ||
    config.assessmenthostedModelId !== undefined ||
    config.assessmenthostedBaseUrl !== undefined ||
    config.assessmenthostedDeploymentId !== undefined
  );
}

// Exactly one adapter is selected from the validated configuration: none
// when the provider is unset, otherwise the single configured provider with
// its model id. Real adapter classes bind to this selection in later
// stories; the shape already guarantees at most one provider.
export function selectAssessmentBinding(config: AppConfig): Result<AssessmentBinding, ConfigError> {
  const provider = config.assessmentProvider;
  if (provider === undefined) {
    if (hasProviderCredentials(config)) {
      return err({
        kind: "invalid-value",
        variable: PROVIDER_VARIABLE,
        reason: "assessment credentials are set without a selected assessment provider",
      });
    }
    return ok({ kind: "disabled" });
  }
  if (provider === "meta-model-api") {
    if (config.assessmentMetaModelId === undefined) {
      return err({ kind: "missing-variable", variable: META_MODEL_VARIABLE });
    }
    return ok({ kind: "enabled", provider, modelId: config.assessmentMetaModelId });
  }
  if (config.assessmenthostedModelId === undefined) {
    return err({ kind: "missing-variable", variable: hosted_MODEL_VARIABLE });
  }
  return ok({ kind: "enabled", provider, modelId: config.assessmenthostedModelId });
}

// Provider and model id for the health response (K-104, K-309).
export function assessmentHealthStatus(binding: AssessmentBinding): AssessmentHealthStatus {
  if (binding.kind === "disabled") {
    return { disabled: true };
  }
  return { provider: binding.provider, modelId: binding.modelId };
}
