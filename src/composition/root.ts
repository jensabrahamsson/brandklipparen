// Composition root: single wiring module (A-03, K-309).
// The root resolves the validated configuration to exactly one assessment
// binding, or none when disabled, and builds the matching assessment
// service for the driving adapters (S-038). No default provider is ever
// chosen here: an unset provider, or a placeholder model id, leaves the
// feature disabled with zero provider calls. Invalid or ambiguous selection
// is a typed startup error naming the variable with values kept outside
// the error text (A-15, K-505).
import { err, ok } from "../domain/result.ts";
import type { Result } from "../domain/result.ts";
import { createAppServices } from "../application/analyzeToken.ts";
import type { AnalyzeTokenPorts, AppServices } from "../application/analyzeToken.ts";
import { createAssessmentService } from "../application/assessmentService.ts";
import type { AssessmentService } from "../application/assessmentService.ts";
import { createMetaModelApiAdapterFromConfig } from "../adapters/assessment/metaModelApi/metaModelApiAdapter.ts";
import type { MetaModelApiTransport } from "../adapters/assessment/metaModelApi/metaModelApiAdapter.ts";
import { createhostedOpenWeightsAdapterFromConfig } from "../adapters/assessment/hostedOpenWeights/hostedOpenWeightsAdapter.ts";
import { hosted_OPEN_WEIGHTS_MODEL_ID } from "../adapters/assessment/hostedOpenWeights/hostedOpenWeightsAdapter.ts";
import type { hostedOpenWeightsTransport } from "../adapters/assessment/hostedOpenWeights/hostedOpenWeightsAdapter.ts";
import { PromptVersion } from "../domain/types.ts";
import { createEmptyPluginRegistry } from "../plugins/registry.ts";
import type { PluginRegistry } from "../plugins/registry.ts";
import type { AppConfig, ConfigError } from "../ports/config.ts";

// S-042 (ADR P-12 step 0): the static plugin registry starts empty beside
// the existing path. The value is validated through the registry builder
// at startup; S-043 threads it into the application service when the
// first detector migrates, leaving analysis output unchanged until then.
export const EMPTY_PLUGIN_REGISTRY: PluginRegistry = createEmptyPluginRegistry();
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

// Documented default assessment intent (S-029, K-309): Jens's demo default
// is the hosted open-weights provider with the published open-weights
// model id. These constants guide documentation, the example environment
// and UI labelling only. The composition root never auto-selects a
// provider: an unset BRANDKLIPPAREN_ASSESSMENT_PROVIDER still disables the
// feature, and a selected provider without its API key stays disabled with
// zero provider calls (not configured) instead of failing startup.
export const DEFAULT_ASSESSMENT_PROVIDER: AssessmentProvider = "hosted-open-weights";
export const DEFAULT_hosted_MODEL_ID: string = hosted_OPEN_WEIGHTS_MODEL_ID;

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

// Placeholder operational default for the per-key daily assessment cap
// (I-08, I-14): read when the validated configuration carries no value
// (local and CI runs). The demo configuration always sets the versioned
// per-key cap, so production never reads this fallback.
const PLACEHOLDER_DAILY_CAP_PER_KEY = 100;

// Placeholder prompt version for runs without a configured prompt: tests
// and offline runs stay well-formed. The demo configuration always sets
// the versioned prompt version per K-305.
const PLACEHOLDER_PROMPT_VERSION = "1.0.0";

// Model ids that read as an unset or placeholder selection: an exact,
// case-insensitive match disables the feature instead of binding an
// adapter. Real model ids from either provider never match these values,
// so a configured provider keeps its binding (K-309).
const PLACEHOLDER_MODEL_IDS: readonly string[] = Object.freeze([
  "placeholder",
  "unset",
  "none",
  "disabled",
  "example",
]);

function isPlaceholderModelId(modelId: string): boolean {
  return PLACEHOLDER_MODEL_IDS.includes(modelId.trim().toLowerCase());
}

export type AssessmentTransportOverrides = {
  readonly metaTransport?: MetaModelApiTransport | undefined;
  readonly hostedTransport?: hostedOpenWeightsTransport | undefined;
};

// Builds the assessment service from the validated configuration (S-038,
// K-309): exactly one provider adapter when the configuration selects one,
// otherwise a disabled service that answers assessment-not-configured with
// zero provider calls. Transports stay injectable so tests replay recorded
// fixtures and never touch the network.
export function createAssessmentServiceFromConfig(
  config: AppConfig,
  services: AppServices,
  overrides: AssessmentTransportOverrides = {},
): Result<AssessmentService, ConfigError> {
  const binding = selectAssessmentBinding(config);
  if (!binding.ok) {
    return err(binding.error);
  }
  const promptVersion =
    config.assessmentPromptVersion === undefined
      ? PromptVersion.parse(PLACEHOLDER_PROMPT_VERSION)
      : ok(config.assessmentPromptVersion);
  if (!promptVersion.ok) {
    return err({
      kind: "invalid-value",
      variable: "BRANDKLIPPAREN_ASSESSMENT_PROMPT_VERSION",
      reason: "must be semver MAJOR.MINOR.PATCH",
    });
  }
  const dailyCapPerKey = config.budgetPerKeyDailyCapAssessmentCalls ?? PLACEHOLDER_DAILY_CAP_PER_KEY;
  const disabled: Result<AssessmentService, ConfigError> = ok(
    createAssessmentService({
      analyze: services.analyzeToken,
      promptVersion: promptVersion.value,
      dailyCapPerKey,
    }),
  );
  if (binding.value.kind === "disabled") {
    return disabled;
  }
  if (isPlaceholderModelId(binding.value.modelId as string)) {
    return disabled;
  }
  if (binding.value.provider === "meta-model-api") {
    const adapter = createMetaModelApiAdapterFromConfig(
      {
        assessmentMetaBaseUrl: config.assessmentMetaBaseUrl,
        assessmentMetaApiKey: config.assessmentMetaApiKey,
        assessmentMetaModelId: config.assessmentMetaModelId,
        assessmentDeadlineMs: config.assessmentDeadlineMs,
        assessmentMaxInputBytes: config.assessmentMaxInputBytes,
        assessmentMaxOutputBytes: config.assessmentMaxOutputBytes,
      },
      overrides.metaTransport,
    );
    if (!adapter.ok) {
      if (adapter.error.kind === "missing-variable") {
        return disabled;
      }
      return err(adapter.error);
    }
    return ok(
      createAssessmentService({
        analyze: services.analyzeToken,
        adapter: adapter.value,
        promptVersion: promptVersion.value,
        dailyCapPerKey,
      }),
    );
  }
  const adapter = createhostedOpenWeightsAdapterFromConfig(
    {
      assessmenthostedBaseUrl: config.assessmenthostedBaseUrl,
      assessmenthostedApiKey: config.assessmenthostedApiKey,
      assessmenthostedModelId: config.assessmenthostedModelId,
      assessmentDeadlineMs: config.assessmentDeadlineMs,
      assessmentMaxInputBytes: config.assessmentMaxInputBytes,
      assessmentMaxOutputBytes: config.assessmentMaxOutputBytes,
    },
    overrides.hostedTransport,
  );
  if (!adapter.ok) {
    // A selected provider without its credentials or endpoint is not
    // configured (S-029): stay disabled with zero provider calls so health
    // reports disabled and the API answers assessment-not-configured.
    // Malformed values stay startup errors.
    if (adapter.error.kind === "missing-variable") {
      return disabled;
    }
    return err(adapter.error);
  }
  return ok(
    createAssessmentService({
      analyze: services.analyzeToken,
      adapter: adapter.value,
      promptVersion: promptVersion.value,
      dailyCapPerKey,
    }),
  );
}
