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
import { DEFAULT_DETECTOR_SET, createAppServices } from "../application/analyzeToken.ts";
import type {
  AnalyzeTokenPorts,
  AppServices,
  DetectorSet,
} from "../application/analyzeToken.ts";
import { createAssessmentService } from "../application/assessmentService.ts";
import type { AssessmentService } from "../application/assessmentService.ts";
import { createMetaModelApiAdapterFromConfig } from "../adapters/assessment/metaModelApi/metaModelApiAdapter.ts";
import type { MetaModelApiTransport } from "../adapters/assessment/metaModelApi/metaModelApiAdapter.ts";
import { createhostedOpenWeightsAdapterFromConfig } from "../adapters/assessment/hostedOpenWeights/hostedOpenWeightsAdapter.ts";
import { hosted_OPEN_WEIGHTS_MODEL_ID } from "../adapters/assessment/hostedOpenWeights/hostedOpenWeightsAdapter.ts";
import type { hostedOpenWeightsTransport } from "../adapters/assessment/hostedOpenWeights/hostedOpenWeightsAdapter.ts";
import { PromptVersion } from "../domain/types.ts";
import {
  assessmentPluginIdForProvider,
  assessmentPluginTable,
} from "../plugins/assessment.ts";
import type { AssessmentPlugin } from "../plugins/assessment.ts";
import {
  ASSESSMENT_PLUGINS,
  buildDefaultAssessmentRegistry,
  createEmptyPluginRegistry,
} from "../plugins/registry.ts";
import type { PluginRegistry } from "../plugins/registry.ts";
import type { PluginId } from "../plugins/api.ts";
import type { AppConfig, ConfigError } from "../ports/config.ts";
import type { MetaModelApiAdapter } from "../adapters/assessment/metaModelApi/metaModelApiAdapter.ts";
import type { hostedOpenWeightsAdapter } from "../adapters/assessment/hostedOpenWeights/hostedOpenWeightsAdapter.ts";

// S-043 (ADR P-12 step 1): the default detector set carries the validated
// plugin registry beside the executable detector lookup, and the shared
// application service runs detection solely through it. The empty S-042
// registry stays for startup tests.
export const EMPTY_PLUGIN_REGISTRY: PluginRegistry = createEmptyPluginRegistry();
import type { ModelId } from "../domain/types.ts";
import type { AssessmentProvider } from "../ports/assessmentModel.ts";

// Single wiring point for the shared application service (A-02, A-03,
// K-027): the root binds each port to exactly one adapter and hands the ready
// AppServices structure to the driving adapters (REST, MCP, web UI) through
// constructor injection. Proxy resolution (S-006) is wired through the same
// structure; just-deployed listing joins it in a later story.
export function wireAppServices(
  ports: AnalyzeTokenPorts,
  detectors: DetectorSet = DEFAULT_DETECTOR_SET,
): AppServices {
  return createAppServices(ports, detectors);
}

export type AssessmentBinding =
  | { readonly kind: "disabled" }
  | {
      readonly kind: "enabled";
      readonly provider: AssessmentProvider;
      readonly modelId: ModelId;
      readonly pluginId: PluginId;
    };

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

// Exactly one assessment plugin is active at a time, selected by plugin
// id from the validated configuration (S-045, P-04, A-34): none when the
// provider is unset, otherwise the single registered plugin for the
// configured provider with its model id. Configuration selects among
// already-registered plugins only and never names code to load (P-07).
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
  const pluginId = assessmentPluginIdForProvider(provider);
  if (provider === "meta-model-api") {
    if (config.assessmentMetaModelId === undefined) {
      return err({ kind: "missing-variable", variable: META_MODEL_VARIABLE });
    }
    return ok({ kind: "enabled", provider, modelId: config.assessmentMetaModelId, pluginId });
  }
  if (config.assessmenthostedModelId === undefined) {
    return err({ kind: "missing-variable", variable: hosted_MODEL_VARIABLE });
  }
  return ok({ kind: "enabled", provider, modelId: config.assessmenthostedModelId, pluginId });
}

// The single active assessment plugin id for an enabled binding, or null
// when the assessment is disabled. The registry lists every registered
// assessment plugin; this value marks the active one (P-08).
export function activeAssessmentPluginId(binding: AssessmentBinding): PluginId | null {
  if (binding.kind === "disabled") {
    return null;
  }
  return binding.pluginId;
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

// Static lookup of registered assessment plugins: the composition root
// resolves the single active plugin through this table, so an
// unregistered plugin never runs.
const ASSESSMENT_PLUGIN_TABLE: ReadonlyMap<PluginId, AssessmentPlugin> =
  assessmentPluginTable(ASSESSMENT_PLUGINS);

// Builds the single active adapter from the registered assessment plugin
// entry (S-045, P-04): the configured plugin id resolves through the
// validated registry first, and the entry's provider selects the existing
// AssessmentModelPort implementation. Selection by configured plugin id
// replaces the former provider branches that named concrete adapters
// outside the registry registration (P-12 step 3).
export function createAssessmentAdapterForPlugin(
  pluginId: PluginId,
  config: AppConfig,
  overrides: AssessmentTransportOverrides = {},
): Result<MetaModelApiAdapter | hostedOpenWeightsAdapter, ConfigError> {
  const assessed = buildDefaultAssessmentRegistry();
  if (!assessed.ok) {
    return err({
      kind: "invalid-value",
      variable: PROVIDER_VARIABLE,
      reason: `assessment plugin registry failed validation: ${assessed.error.kind}`,
    });
  }
  const plugin = ASSESSMENT_PLUGIN_TABLE.get(pluginId);
  const registered = assessed.value.plugins.some((entry) => entry.id === pluginId);
  if (plugin === undefined || !registered) {
    return err({
      kind: "invalid-value",
      variable: PROVIDER_VARIABLE,
      reason: "assessment plugin id is not registered",
    });
  }
  if (plugin.provider === "meta-model-api") {
    return createMetaModelApiAdapterFromConfig(
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
  }
  return createhostedOpenWeightsAdapterFromConfig(
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
}


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
  // The single active adapter builds from the registered assessment
  // plugin entry for the configured plugin id (S-045, P-12 step 3).
  const adapter = createAssessmentAdapterForPlugin(binding.value.pluginId, config, overrides);
  if (!adapter.ok) {
    // A selected plugin without its credentials or endpoint is not
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
