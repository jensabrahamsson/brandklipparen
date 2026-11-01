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
import type {
  AnalyzeTokenPorts,
  AppServices,
  DetectorSet,
} from "../application/analyzeToken.ts";
import { createAssessmentService } from "../application/assessmentService.ts";
import type { AssessmentService } from "../application/assessmentService.ts";
import { createPersonalizeService } from "../application/personalizeService.ts";
import type { PersonalizeService } from "../application/personalizeService.ts";
import { OverlayBudget } from "../application/overlayBudget.ts";
import {
  NotConfiguredPersonalizeAdapter,
} from "../adapters/personalize/hostedPersonalizeAdapter.ts";
import { createMetaModelApiPersonalizeAdapterFromConfig } from "../adapters/personalize/metaModelApiPersonalizeAdapter.ts";
import type { MetaModelApiPersonalizeTransport } from "../adapters/personalize/metaModelApiPersonalizeAdapter.ts";
import { createGenericCompatiblePersonalizeAdapterFromConfig } from "../adapters/personalize/GenericCompatiblePersonalizeAdapter.ts";
import type { GenericCompatiblePersonalizeTransport } from "../adapters/personalize/GenericCompatiblePersonalizeAdapter.ts";
import type { PluginPersonalizeModelPort } from "../ports/pluginPersonalizeModel.ts";
import type { PluginPersonalizeProvider } from "../ports/pluginPersonalizeModel.ts";
import {
  PLACEHOLDER_INVESTIGATION_DAILY_CAP_PER_KEY,
  PLACEHOLDER_INVESTIGATION_PROMPT_VERSION,
  createInvestigationService,
} from "../application/investigationService.ts";
import type { InvestigationService } from "../application/investigationService.ts";
import { createDecompilerNamingService } from "../application/decompilerNaming.ts";
import type { DecompilerNamingService } from "../application/decompilerNaming.ts";
import type { DecompilerNamingPort } from "../ports/decompilerNaming.ts";
import {
  hostedInvestigateAdapter,
  NotConfiguredInvestigateAdapter,
  createhostedInvestigateAdapterFromConfig,
} from "../adapters/investigation/hostedInvestigateAdapter.ts";
import type { hostedInvestigateTransport } from "../adapters/investigation/hostedInvestigateAdapter.ts";
import {
  META_INVESTIGATE_LOOP_DEADLINE_MS,
  META_INVESTIGATE_LOOP_MAX_TOKENS,
  createMetaModelApiInvestigateAdapterFromConfig,
} from "../adapters/investigation/metaModelApiInvestigateAdapter.ts";
import {
  OVERLAY_META_MODEL_ID,
  createMetaModelApiChatAdapterFromConfig,
  createMetaModelApiExplainAdapterFromConfig,
  createMetaModelApiExplainCodeAdapterFromConfig,
  createMetaModelApiRugAdapterFromConfig,
} from "../adapters/overlays/metaModelApiOverlays.ts";
import type { OverlayTransport } from "../adapters/overlays/metaModelApiOverlays.ts";
import { createChatService } from "../application/chatService.ts";
import type { ChatService } from "../application/chatService.ts";
import { createExplainService } from "../application/explainService.ts";
import type { ExplainService } from "../application/explainService.ts";
import { createRugService } from "../application/rugService.ts";
import type { RugService } from "../application/rugService.ts";
import { createExplainCodeService } from "../application/explainCodeService.ts";
import type { ExplainCodeService } from "../application/explainCodeService.ts";
import type { ChatModelPort } from "../ports/chatModel.ts";
import type { ExplainCodeModelPort } from "../ports/explainCodeModel.ts";
import type { ExplainModelPort } from "../ports/explainModel.ts";
import type { RugModelPort } from "../ports/rugModel.ts";
import type { InvestigationModelPort } from "../ports/investigationModel.ts";
import { DEFAULT_INVESTIGATION_LIMITS } from "../application/investigateToken.ts";
import { createMetaModelApiAdapterFromConfig } from "../adapters/assessment/metaModelApi/metaModelApiAdapter.ts";
import type { MetaModelApiTransport } from "../adapters/assessment/metaModelApi/metaModelApiAdapter.ts";
import { createhostedOpenWeightsAdapterFromConfig } from "../adapters/assessment/hostedOpenWeights/hostedOpenWeightsAdapter.ts";
import { hosted_OPEN_WEIGHTS_MODEL_ID } from "../adapters/assessment/hostedOpenWeights/hostedOpenWeightsAdapter.ts";
import type { hostedOpenWeightsTransport } from "../adapters/assessment/hostedOpenWeights/hostedOpenWeightsAdapter.ts";
import { createGenericCompatibleAdapterFromConfig } from "../adapters/assessment/GenericCompatible/GenericCompatibleAdapter.ts";
import type { GenericCompatibleTransport } from "../adapters/assessment/GenericCompatible/GenericCompatibleAdapter.ts";
import { PromptVersion } from "../domain/types.ts";
import {
  assessmentPluginIdForProvider,
  assessmentPluginTable,
} from "../plugins/assessment.ts";
import type { AssessmentPlugin } from "../plugins/assessment.ts";
import {
  ASSESSMENT_PLUGINS,
  DEFAULT_DETECTOR_PLUGINS,
  buildDefaultAssessmentRegistry,
  buildPluginRegistry,
} from "../plugins/registry.ts";
import type { PluginRegistryError } from "../plugins/registry.ts";
import type { PluginId } from "../plugins/api.ts";
import type { AppConfig, ConfigError } from "../ports/config.ts";
import type { MetaModelApiAdapter } from "../adapters/assessment/metaModelApi/metaModelApiAdapter.ts";
import type { hostedOpenWeightsAdapter } from "../adapters/assessment/hostedOpenWeights/hostedOpenWeightsAdapter.ts";
import type { GenericCompatibleAdapter } from "../adapters/assessment/GenericCompatible/GenericCompatibleAdapter.ts";
import { ModelId } from "../domain/types.ts";
import type { AssessmentProvider } from "../ports/assessmentModel.ts";

// Builds the detector set the shared application service runs (S-043,
// P-08; entries in S-071 per ADR section 0.3, D-5): the startup builder
// validates the static first-party entry set once and the composition
// root maps a failure to a typed startup error. Nothing is built at
// module load, and no defaulted set exists: callers wire the returned set
// explicitly through `wireAppServices`.
export function buildDetectorSet(): Result<DetectorSet, PluginRegistryError> {
  const built = buildPluginRegistry(DEFAULT_DETECTOR_PLUGINS);
  if (!built.ok) {
    return err(built.error);
  }
  return ok(Object.freeze({ registry: built.value }));
}

// Single wiring point for the shared application service (A-02, A-03,
// K-027): the root binds each port to exactly one adapter and hands the ready
// AppServices structure to the driving adapters (REST, MCP, web UI) through
// constructor injection. Proxy resolution (S-006) is wired through the same
// structure; just-deployed listing joins it in a later story. The detector
// set is required explicitly: it comes from `buildDetectorSet`, so a
// caller cannot forget to wire the real set.
export function wireAppServices(ports: AnalyzeTokenPorts, detectors: DetectorSet): AppServices {
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
    config.assessmenthostedDeploymentId !== undefined ||
    config.assessmentGenericCompatibleApiKey !== undefined ||
    config.assessmentGenericCompatibleModelId !== undefined ||
    config.assessmentGenericCompatibleBaseUrl !== undefined
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
  // A selected provider without its model id, key or endpoint is not
  // configured (S-135): the binding stays disabled with zero provider
  // calls, consistent with how a missing key already maps to disabled in
  // the adapter factory below. Present-but-malformed values never reach
  // this point: the config loader turns them away as typed startup errors.
  if (provider === "meta-model-api") {
    if (
      config.assessmentMetaModelId === undefined ||
      config.assessmentMetaApiKey === undefined ||
      config.assessmentMetaBaseUrl === undefined
    ) {
      return ok({ kind: "disabled" });
    }
    return ok({ kind: "enabled", provider, modelId: config.assessmentMetaModelId, pluginId });
  }
  if (provider === "generic-compatible") {
    if (
      config.assessmentGenericCompatibleModelId === undefined ||
      config.assessmentGenericCompatibleApiKey === undefined ||
      config.assessmentGenericCompatibleBaseUrl === undefined
    ) {
      return ok({ kind: "disabled" });
    }
    return ok({ kind: "enabled", provider, modelId: config.assessmentGenericCompatibleModelId, pluginId });
  }
  if (
    config.assessmenthostedModelId === undefined ||
    config.assessmenthostedApiKey === undefined ||
    config.assessmenthostedBaseUrl === undefined
  ) {
    return ok({ kind: "disabled" });
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
  readonly GenericCompatibleTransport?: GenericCompatibleTransport | undefined;
};

export type PersonalizeBinding =
  | { readonly kind: "disabled" }
  | {
      readonly kind: "enabled";
      readonly provider: PluginPersonalizeProvider;
      readonly modelId: ModelId;
    };

// Placeholder operational default for the per-key personalize daily cap:
// read when the validated configuration carries no value (local and CI
// runs). The mapping call is one small spec per uncached view, so the
// default stays small; the demo configuration always sets the versioned
// per-key cap when the feature is on.
const DEFAULT_PERSONALIZE_DAILY_CAP_PER_KEY = 5;

// Placeholder mapping prompt version for runs without a configured
// prompt: tests and offline runs stay well-formed. The adapter prompt and
// the cache key record this same version.
export const PERSONALIZE_PROMPT_VERSION = "1.0.0";

// Exactly one personalize mapping binding, or none when disabled (S-069,
// P-27): unset or "off" leaves the feature disabled with zero provider
// calls, and the deterministic baseline stands. A selected provider
// without its key, model id or endpoint is not configured (S-135): the
// binding stays disabled with zero provider calls instead of failing
// startup. Present-but-malformed values never reach this point: the
// config loader turns them away as typed startup errors.
export function selectPersonalizeBinding(config: AppConfig): Result<PersonalizeBinding, ConfigError> {
  const provider = config.personalizeProvider;
  if (provider === undefined) {
    return ok({ kind: "disabled" });
  }
  if (provider === "meta-model-api") {
    if (
      config.assessmentMetaModelId === undefined ||
      config.assessmentMetaApiKey === undefined ||
      config.assessmentMetaBaseUrl === undefined
    ) {
      return ok({ kind: "disabled" });
    }
    return ok({ kind: "enabled", provider, modelId: config.assessmentMetaModelId });
  }
  if (provider === "generic-compatible") {
    if (
      config.assessmentGenericCompatibleModelId === undefined ||
      config.assessmentGenericCompatibleApiKey === undefined ||
      config.assessmentGenericCompatibleBaseUrl === undefined
    ) {
      return ok({ kind: "disabled" });
    }
    return ok({ kind: "enabled", provider, modelId: config.assessmentGenericCompatibleModelId });
  }
  // The hosted mapping triple has no validated configuration fields, so
  // selecting it keeps the previous behaviour: not configured with zero
  // provider calls and the deterministic baseline standing.
  return ok({ kind: "disabled" });
}

// Provider and model id for the health response (K-104, S-123): the
// service reports its bound adapter, so the UI names the configured
// provider and model id honestly instead of a hard-coded label.
export function personalizeHealthStatus(binding: PersonalizeBinding): { provider: PluginPersonalizeProvider; modelId: ModelId } | { disabled: true } {
  if (binding.kind === "disabled") {
    return { disabled: true };
  }
  return { provider: binding.provider, modelId: binding.modelId };
}

export type PersonalizeTransportOverrides = {
  readonly transport?: GenericCompatiblePersonalizeTransport | undefined;
  readonly metaTransport?: MetaModelApiPersonalizeTransport | undefined;
  readonly onWarn?: ((line: string) => void) | undefined;
};

// Builds the personalize service from the validated configuration
// (S-069, P-27): the meta-model-api or generic-compatible mapping adapter
// when the provider is configured with its connection triple, otherwise
// undefined so the routes answer not-configured with zero provider
// calls. Missing values never fail startup: the feature is opt-in and
// off by default. Transports stay injectable so tests replay recorded
// fixtures and never touch the network.
export function createPersonalizeServiceFromConfig(
  config: AppConfig,
  overrides: PersonalizeTransportOverrides = {},
): Result<PersonalizeService | undefined, ConfigError> {
  const binding = selectPersonalizeBinding(config);
  if (!binding.ok) {
    return err(binding.error);
  }
  if (binding.value.kind === "disabled") {
    return ok(undefined);
  }
  if (isPlaceholderModelId(binding.value.modelId as string)) {
    return ok(undefined);
  }
  let adapter: PluginPersonalizeModelPort;
  if (binding.value.provider === "meta-model-api") {
    const built = createMetaModelApiPersonalizeAdapterFromConfig(
      {
        assessmentMetaBaseUrl: config.assessmentMetaBaseUrl,
        assessmentMetaApiKey: config.assessmentMetaApiKey,
        assessmentMetaModelId: config.assessmentMetaModelId,
      },
      overrides.metaTransport,
      undefined,
      overrides.onWarn,
    );
    if (!built.ok) {
      return err(built.error);
    }
    adapter = built.value;
  } else if (binding.value.provider === "generic-compatible") {
    const built = createGenericCompatiblePersonalizeAdapterFromConfig(
      {
        assessmentGenericCompatibleBaseUrl: config.assessmentGenericCompatibleBaseUrl,
        assessmentGenericCompatibleApiKey: config.assessmentGenericCompatibleApiKey,
        assessmentGenericCompatibleModelId: config.assessmentGenericCompatibleModelId,
      },
      overrides.transport,
      undefined,
      overrides.onWarn,
    );
    if (!built.ok) {
      return err(built.error);
    }
    adapter = built.value;
  } else {
    adapter = new NotConfiguredPersonalizeAdapter(undefined, binding.value.provider);
  }
  return ok(
    createPersonalizeService({
      adapter,
      budget: new OverlayBudget({
        dailyCapPerKey: config.personalizeDailyCapPerKey ?? DEFAULT_PERSONALIZE_DAILY_CAP_PER_KEY,
        globalDailyCap: aiGlobalDailyCap(config),
        today: () => new Date().toISOString().slice(0, 10),
      }),
    }),
  );
}

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
): Result<MetaModelApiAdapter | hostedOpenWeightsAdapter | GenericCompatibleAdapter, ConfigError> {
  const assessed = buildDefaultAssessmentRegistry();
  if (!assessed.ok) {
    return err({
      kind: "invalid-value",
      variable: PROVIDER_VARIABLE,
      reason: `assessment plugin registry failed validation: ${assessed.error.kind}`,
    });
  }
  const plugin = ASSESSMENT_PLUGIN_TABLE.get(pluginId);
  const registered = assessed.value.entries.some((entry) => entry.manifest.id === pluginId);
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
  if (plugin.provider === "generic-compatible") {
    return createGenericCompatibleAdapterFromConfig(
      {
        assessmentGenericCompatibleBaseUrl: config.assessmentGenericCompatibleBaseUrl,
        assessmentGenericCompatibleApiKey: config.assessmentGenericCompatibleApiKey,
        assessmentGenericCompatibleModelId: config.assessmentGenericCompatibleModelId,
        assessmentDeadlineMs: config.assessmentDeadlineMs,
        assessmentMaxInputBytes: config.assessmentMaxInputBytes,
        assessmentMaxOutputBytes: config.assessmentMaxOutputBytes,
        assessmentGenericCompatibleTemperature: config.assessmentGenericCompatibleTemperature,
        assessmentGenericCompatibleMaxTokens: config.assessmentGenericCompatibleMaxTokens,
      },
      overrides.GenericCompatibleTransport,
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
      globalDailyCap: aiGlobalDailyCap(config),
    }),
  );
}

// Builds the decompiler naming service (S-083, D-11): the default wiring
// carries no port, so the suggested-names overlay stays off and the
// deterministic pseudo-Solidity stands. A future hosted naming adapter (or
// the fake in tests) passes its port here explicitly to opt in; the
// overlay never enters scoring, evidence or emitted structure.
export function buildDecompilerNamingService(
  port: DecompilerNamingPort | null = null,
): DecompilerNamingService {
  return createDecompilerNamingService(port);
}

// Vendor-neutral sharing for local development: when the assessment
// selects the vendor-neutral provider with a complete endpoint triple
// and no investigation field is configured at all, the investigation
// loop reuses the assessment endpoint, key and model id. Any explicit
// investigation selection or field keeps the existing path below
// (including the not-configured adapter on a partial triple); without
// either, the loop stays not-configured. Returns null when sharing does
// not apply.
function sharedInvestigateAdapterFromAssessment(
  config: AppConfig,
  transport: hostedInvestigateTransport | undefined,
): InvestigationModelPort | null {
  if (config.investigateProvider !== undefined) {
    return null;
  }
  if (
    config.investigatehostedBaseUrl !== undefined ||
    config.investigatehostedApiKey !== undefined ||
    config.investigatehostedModelId !== undefined ||
    config.investigateMetaBaseUrl !== undefined ||
    config.investigateMetaApiKey !== undefined ||
    config.investigateMetaModelId !== undefined
  ) {
    return null;
  }
  if (config.assessmentProvider !== "generic-compatible") {
    return null;
  }
  const endpoint = config.assessmentGenericCompatibleBaseUrl;
  const apiKey = config.assessmentGenericCompatibleApiKey;
  const modelId = config.assessmentGenericCompatibleModelId;
  if (endpoint === undefined || apiKey === undefined || modelId === undefined) {
    return null;
  }
  return new hostedInvestigateAdapter({
    endpoint,
    apiKey,
    modelId,
    provider: "generic-compatible",
    timeoutMs: config.investigateDeadlineMs,
    maxBytesIn: config.investigateMaxOutputBytes,
    maxBytesOut: config.investigateMaxInputBytes,
    maxOutputChars: config.investigateMaxOutputBytes,
    transport,
  });
}

function buildInvestigationService(
  adapter: InvestigationModelPort,
  config: AppConfig,
  detectors: DetectorSet,
  configured: boolean,
  // Fallback loop budget when the validated configuration names no
  // explicit value: the Meta reasoning path passes a larger budget (up to
  // 8 steps of a reasoning model); every other path keeps the shared
  // defaults. Explicit configuration always wins.
  loopDefaults: { readonly maxTokens: number; readonly deadlineMs: number } = {
    maxTokens: DEFAULT_INVESTIGATION_LIMITS.maxTokens,
    deadlineMs: DEFAULT_INVESTIGATION_LIMITS.deadlineMs,
  },
): InvestigationService {
  return createInvestigationService({
    adapter,
    detectors,
    docs: {},
    limits: {
      maxSteps: config.investigateMaxSteps ?? DEFAULT_INVESTIGATION_LIMITS.maxSteps,
      maxTokens: config.investigateMaxTokens ?? loopDefaults.maxTokens,
      deadlineMs: config.investigateDeadlineMs ?? loopDefaults.deadlineMs,
      toolTimeoutMs: config.investigateToolTimeoutMs ?? DEFAULT_INVESTIGATION_LIMITS.toolTimeoutMs,
    },
    promptVersion:
      config.investigatePromptVersion === undefined
        ? PLACEHOLDER_INVESTIGATION_PROMPT_VERSION
        : (config.investigatePromptVersion as string),
    dailyCapPerKey: config.investigateDailyCapPerKey ?? PLACEHOLDER_INVESTIGATION_DAILY_CAP_PER_KEY,
    configured,
  });
}

function hostedInvestigateLimitsOf(config: AppConfig): {
  readonly investigateDeadlineMs: number | undefined;
  readonly investigateMaxInputBytes: number | undefined;
  readonly investigateMaxOutputBytes: number | undefined;
} {
  return {
    investigateDeadlineMs: config.investigateDeadlineMs,
    investigateMaxInputBytes: config.investigateMaxInputBytes,
    investigateMaxOutputBytes: config.investigateMaxOutputBytes,
  };
}

// Builds the investigation service from the validated configuration
// (S-075, P-29): the selected provider adapter when its connection triple
// is complete (Meta Model API or hosted open weights), the shared
// vendor-neutral adapter when the assessment selects the vendor-neutral
// provider without an explicit investigation selection, otherwise the
// not-configured adapter whose every call answers `not-configured` with
// zero sends. The service reports unconfigured through its `configured`
// flag so health can disable the loop while the routes keep their typed
// not-configured response. Missing values never fail startup: the loop
// is opt-in and disabled by default. Transports stay injectable so tests
// replay recorded fixtures and never touch the network.
export function createInvestigationServiceFromConfig(
  config: AppConfig,
  detectors: DetectorSet,
  overrides: { readonly transport?: hostedInvestigateTransport | undefined } = {},
): Result<InvestigationService, ConfigError> {
  const selected = config.investigateProvider;
  if (selected === "off") {
    const built = createhostedInvestigateAdapterFromConfig(
      {
        investigatehostedBaseUrl: undefined,
        investigatehostedApiKey: undefined,
        investigatehostedModelId: undefined,
        ...hostedInvestigateLimitsOf(config),
      },
      overrides.transport,
    );
    if (!built.ok) {
      return err(built.error);
    }
    return ok(buildInvestigationService(built.value, config, detectors, false));
  }
  if (selected === "meta-model-api") {
    const built = createMetaModelApiInvestigateAdapterFromConfig(
      {
        investigateMetaBaseUrl: config.investigateMetaBaseUrl,
        investigateMetaApiKey: config.investigateMetaApiKey,
        investigateMetaModelId: config.investigateMetaModelId,
        investigateDeadlineMs: config.investigateDeadlineMs,
        investigateMaxInputBytes: config.investigateMaxInputBytes,
        investigateMaxOutputBytes: config.investigateMaxOutputBytes,
      },
      overrides.transport,
    );
    if (!built.ok) {
      return err(built.error);
    }
    return ok(
      buildInvestigationService(
        built.value,
        config,
        detectors,
        !(built.value instanceof NotConfiguredInvestigateAdapter),
        {
          maxTokens: META_INVESTIGATE_LOOP_MAX_TOKENS,
          deadlineMs: META_INVESTIGATE_LOOP_DEADLINE_MS,
        },
      ),
    );
  }
  if (selected === "hosted-open-weights") {
    const built = createhostedInvestigateAdapterFromConfig(
      {
        investigatehostedBaseUrl: config.investigatehostedBaseUrl,
        investigatehostedApiKey: config.investigatehostedApiKey,
        investigatehostedModelId: config.investigatehostedModelId,
        ...hostedInvestigateLimitsOf(config),
      },
      overrides.transport,
    );
    if (!built.ok) {
      return err(built.error);
    }
    return ok(
      buildInvestigationService(
        built.value,
        config,
        detectors,
        !(built.value instanceof NotConfiguredInvestigateAdapter),
      ),
    );
  }
  const shared = sharedInvestigateAdapterFromAssessment(config, overrides.transport);
  if (shared !== null) {
    return ok(buildInvestigationService(shared, config, detectors, true));
  }
  const built = createhostedInvestigateAdapterFromConfig(
    {
      investigatehostedBaseUrl: config.investigatehostedBaseUrl,
      investigatehostedApiKey: config.investigatehostedApiKey,
      investigatehostedModelId: config.investigatehostedModelId,
      ...hostedInvestigateLimitsOf(config),
    },
    overrides.transport,
  );
  if (!built.ok) {
    return err(built.error);
  }
  return ok(
    buildInvestigationService(
      built.value,
      config,
      detectors,
      !(built.value instanceof NotConfiguredInvestigateAdapter),
    ),
  );
}

// Overlay provider selection (explain, chat, rug): unset or "off" leaves
// the feature disabled with zero provider calls, and the deterministic
// explanation stands. A selected provider without its key or endpoint is
// not configured: the binding stays disabled with zero provider calls
// instead of failing startup. Present-but-malformed values never reach
// this point: the config loader turns them away as typed startup errors.
export type OverlayProvider = "meta-model-api";

export type OverlayBinding =
  | { readonly kind: "disabled" }
  | { readonly kind: "enabled"; readonly provider: OverlayProvider; readonly modelId: ModelId };

export function selectExplainBinding(config: AppConfig): Result<OverlayBinding, ConfigError> {
  const provider = config.explainProvider;
  if (provider === undefined || provider === "off") {
    return ok({ kind: "disabled" });
  }
  if (config.explainMetaApiKey === undefined || config.explainMetaBaseUrl === undefined) {
    return ok({ kind: "disabled" });
  }
  const modelId = config.explainMetaModelId;
  if (modelId !== undefined && isPlaceholderModelId(modelId as string)) {
    return ok({ kind: "disabled" });
  }
  return ok({
    kind: "enabled",
    provider: "meta-model-api",
    modelId: (modelId ?? defaultOverlayModelId()) as ModelId,
  });
}

export function selectChatBinding(config: AppConfig): Result<OverlayBinding, ConfigError> {
  const provider = config.chatProvider;
  if (provider === undefined || provider === "off") {
    return ok({ kind: "disabled" });
  }
  if (config.chatMetaApiKey === undefined || config.chatMetaBaseUrl === undefined) {
    return ok({ kind: "disabled" });
  }
  const modelId = config.chatMetaModelId;
  if (modelId !== undefined && isPlaceholderModelId(modelId as string)) {
    return ok({ kind: "disabled" });
  }
  return ok({
    kind: "enabled",
    provider: "meta-model-api",
    modelId: (modelId ?? defaultOverlayModelId()) as ModelId,
  });
}

export function selectRugBinding(config: AppConfig): Result<OverlayBinding, ConfigError> {
  const provider = config.rugProvider;
  if (provider === undefined || provider === "off") {
    return ok({ kind: "disabled" });
  }
  if (config.rugMetaApiKey === undefined || config.rugMetaBaseUrl === undefined) {
    return ok({ kind: "disabled" });
  }
  const modelId = config.rugMetaModelId;
  if (modelId !== undefined && isPlaceholderModelId(modelId as string)) {
    return ok({ kind: "disabled" });
  }
  return ok({
    kind: "enabled",
    provider: "meta-model-api",
    modelId: (modelId ?? defaultOverlayModelId()) as ModelId,
  });
}

export function selectExplainCodeBinding(config: AppConfig): Result<OverlayBinding, ConfigError> {
  const provider = config.explainCodeProvider;
  if (provider === undefined || provider === "off") {
    return ok({ kind: "disabled" });
  }
  if (config.explainCodeMetaApiKey === undefined || config.explainCodeMetaBaseUrl === undefined) {
    return ok({ kind: "disabled" });
  }
  const modelId = config.explainCodeMetaModelId;
  if (modelId !== undefined && isPlaceholderModelId(modelId as string)) {
    return ok({ kind: "disabled" });
  }
  return ok({
    kind: "enabled",
    provider: "meta-model-api",
    modelId: (modelId ?? defaultOverlayModelId()) as ModelId,
  });
}

// Provider and model id for the health response: the service reports its
// bound adapter, so the UI names the configured provider and model id
// honestly instead of a hard-coded label.
export function overlayHealthStatus(
  service: ExplainService | ChatService | RugService | ExplainCodeService | undefined,
): { provider: string; modelId: string } | { disabled: true } {
  if (service === undefined || !service.enabled || service.provider === null || service.modelId === null) {
    return { disabled: true };
  }
  return { provider: service.provider, modelId: service.modelId };
}

// Placeholder operational default for the per-key overlay daily caps:
// read when the validated configuration carries no value (local and CI
// runs). One overlay call is one small sentence list per uncached input,
// so the default stays small; the demo configuration always sets the
// versioned per-key cap when the feature is on.
const DEFAULT_OVERLAY_DAILY_CAP_PER_KEY = 5;

// SEC-1 S-8: conservative global daily cap for Meta Model API calls
// when the operator sets no value. Per-key caps still apply first.
export const DEFAULT_AI_GLOBAL_DAILY_CALLS = 1000;

function aiGlobalDailyCap(config: AppConfig): number {
  return config.aiGlobalDailyCalls ?? DEFAULT_AI_GLOBAL_DAILY_CALLS;
}

function defaultOverlayModelId(): ModelId {
  const parsed = ModelId.parse(OVERLAY_META_MODEL_ID);
  if (!parsed.ok) {
    throw new Error("the pinned overlay Meta model id must parse");
  }
  return parsed.value;
}

export type OverlayTransportOverrides = {
  readonly explainTransport?: OverlayTransport | undefined;
  readonly chatTransport?: OverlayTransport | undefined;
  readonly rugTransport?: OverlayTransport | undefined;
  readonly explainCodeTransport?: OverlayTransport | undefined;
};

// Builds the explain service from the validated configuration: the
// meta-model-api adapter when the provider is configured with its
// connection pair, otherwise undefined so the routes answer not-configured
// with zero provider calls. Missing values never fail startup: the feature
// is opt-in and off by default. Transports stay injectable so tests replay
// recorded fixtures and never touch the network.
export function createExplainServiceFromConfig(
  config: AppConfig,
  overrides: OverlayTransportOverrides = {},
): Result<ExplainService | undefined, ConfigError> {
  const binding = selectExplainBinding(config);
  if (!binding.ok) {
    return err(binding.error);
  }
  if (binding.value.kind === "disabled") {
    return ok(undefined);
  }
  const built = createMetaModelApiExplainAdapterFromConfig(
    {
      explainMetaBaseUrl: config.explainMetaBaseUrl,
      explainMetaApiKey: config.explainMetaApiKey,
      explainMetaModelId: config.explainMetaModelId,
    },
    overrides.explainTransport,
  );
  if (!built.ok) {
    return err(built.error);
  }
  const port: ExplainModelPort | null = built.value;
  if (port === null) {
    return ok(undefined);
  }
  return ok(
    createExplainService(
      port,
      new OverlayBudget({
        dailyCapPerKey: config.explainDailyCapPerKey ?? DEFAULT_OVERLAY_DAILY_CAP_PER_KEY,
        globalDailyCap: aiGlobalDailyCap(config),
        today: () => new Date().toISOString().slice(0, 10),
      }),
    ),
  );
}

// Builds the chat service from the validated configuration: the
// meta-model-api adapter when the provider is configured with its
// connection pair, otherwise undefined so the routes answer not-configured
// with zero provider calls.
export function createChatServiceFromConfig(
  config: AppConfig,
  overrides: OverlayTransportOverrides = {},
): Result<ChatService | undefined, ConfigError> {
  const binding = selectChatBinding(config);
  if (!binding.ok) {
    return err(binding.error);
  }
  if (binding.value.kind === "disabled") {
    return ok(undefined);
  }
  const built = createMetaModelApiChatAdapterFromConfig(
    {
      chatMetaBaseUrl: config.chatMetaBaseUrl,
      chatMetaApiKey: config.chatMetaApiKey,
      chatMetaModelId: config.chatMetaModelId,
    },
    overrides.chatTransport,
  );
  if (!built.ok) {
    return err(built.error);
  }
  const port: ChatModelPort | null = built.value;
  if (port === null) {
    return ok(undefined);
  }
  return ok(
    createChatService(
      port,
      new OverlayBudget({
        dailyCapPerKey: config.chatDailyCapPerKey ?? DEFAULT_OVERLAY_DAILY_CAP_PER_KEY,
        globalDailyCap: aiGlobalDailyCap(config),
        today: () => new Date().toISOString().slice(0, 10),
      }),
    ),
  );
}

// Builds the rug narrative service from the validated configuration: the
// meta-model-api adapter when the provider is configured with its
// connection pair, otherwise undefined so the routes answer not-configured
// with zero provider calls.
export function createRugServiceFromConfig(
  config: AppConfig,
  overrides: OverlayTransportOverrides = {},
): Result<RugService | undefined, ConfigError> {
  const binding = selectRugBinding(config);
  if (!binding.ok) {
    return err(binding.error);
  }
  if (binding.value.kind === "disabled") {
    return ok(undefined);
  }
  const built = createMetaModelApiRugAdapterFromConfig(
    {
      rugMetaBaseUrl: config.rugMetaBaseUrl,
      rugMetaApiKey: config.rugMetaApiKey,
      rugMetaModelId: config.rugMetaModelId,
    },
    overrides.rugTransport,
  );
  if (!built.ok) {
    return err(built.error);
  }
  const port: RugModelPort | null = built.value;
  if (port === null) {
    return ok(undefined);
  }
  return ok(
    createRugService(
      port,
      new OverlayBudget({
        dailyCapPerKey: config.rugDailyCapPerKey ?? DEFAULT_OVERLAY_DAILY_CAP_PER_KEY,
        globalDailyCap: aiGlobalDailyCap(config),
        today: () => new Date().toISOString().slice(0, 10),
      }),
    ),
  );
}

// Builds the explain-code service from the validated configuration: the
// meta-model-api adapter when the provider is configured with its
// connection pair, otherwise undefined so the route answers not-configured
// with zero provider calls.
export function createExplainCodeServiceFromConfig(
  config: AppConfig,
  overrides: OverlayTransportOverrides = {},
): Result<ExplainCodeService | undefined, ConfigError> {
  const binding = selectExplainCodeBinding(config);
  if (!binding.ok) {
    return err(binding.error);
  }
  if (binding.value.kind === "disabled") {
    return ok(undefined);
  }
  const built = createMetaModelApiExplainCodeAdapterFromConfig(
    {
      explainCodeMetaBaseUrl: config.explainCodeMetaBaseUrl,
      explainCodeMetaApiKey: config.explainCodeMetaApiKey,
      explainCodeMetaModelId: config.explainCodeMetaModelId,
    },
    overrides.explainCodeTransport,
  );
  if (!built.ok) {
    return err(built.error);
  }
  const port: ExplainCodeModelPort | null = built.value;
  if (port === null) {
    return ok(undefined);
  }
  return ok(
    createExplainCodeService(
      port,
      new OverlayBudget({
        dailyCapPerKey: config.explainCodeDailyCapPerKey ?? DEFAULT_OVERLAY_DAILY_CAP_PER_KEY,
        globalDailyCap: aiGlobalDailyCap(config),
        today: () => new Date().toISOString().slice(0, 10),
      }),
    ),
  );
}
