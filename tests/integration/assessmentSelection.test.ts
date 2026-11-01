// Composition-root provider selection (S-025, K-309).
// Written first per A-21: config selects exactly one assessment adapter,
// or none when disabled. Invalid or ambiguous selection is a typed startup
// error naming the variable with values kept outside the error text.
import { describe, expect, test } from "vitest";
import { loadConfig } from "../../src/adapters/config/loader.ts";
import { SecretString, formatConfigError } from "../../src/ports/config.ts";
import type { AppConfig } from "../../src/ports/config.ts";
import {
  assessmentHealthStatus,
  activeAssessmentPluginId,
  createAssessmentServiceFromConfig,
  DEFAULT_ASSESSMENT_PROVIDER,
  DEFAULT_hosted_MODEL_ID,
  selectAssessmentBinding,
} from "../../src/composition/root.ts";
import { assessmentPluginTable, getAssessmentPlugin } from "../../src/plugins/assessment.ts";
import { ASSESSMENT_PLUGINS } from "../../src/plugins/registry.ts";
import { IndexVersion, ModelId, ModelVersion } from "../../src/domain/types.ts";
import type { AppServices } from "../../src/application/analyzeToken.ts";
import type { Result } from "../../src/domain/result.ts";

function mustOk<T>(result: Result<T, { message: string }>): T {
  if (!result.ok) {
    throw new Error(`expected ok, got error: ${result.error.message}`);
  }
  return result.value;
}

function baseCiEnv(): Record<string, string | undefined> {
  return {
    BRANDKLIPPAREN_ENV: "ci",
    BRANDKLIPPAREN_MODEL_VERSION: "0.1.0",
    BRANDKLIPPAREN_MODEL_ARTIFACT_PATH: "model/artifact-0.1.0.json",
    BRANDKLIPPAREN_CLONE_INDEX_VERSION: "1.0.0",
    BRANDKLIPPAREN_LOG_LEVEL: "info",
  };
}

function sharedDemoEnv(): Record<string, string | undefined> {
  return {
    ...baseCiEnv(),
    BRANDKLIPPAREN_ENV: "demo",
    BRANDKLIPPAREN_HTTP_PORT: "8080",
    BRANDKLIPPAREN_RPC_URLS: "https://rpc.example.invalid",
    BRANDKLIPPAREN_CHAIN_ID: "1",
    BRANDKLIPPAREN_RPC_DEADLINE_MS: "4000",
    BRANDKLIPPAREN_RPC_MAX_CONCURRENCY: "8",
    BRANDKLIPPAREN_RPC_RETRY_BUDGET: "2",
    BRANDKLIPPAREN_RPC_MAX_RESPONSE_BYTES: "1000000",
    BRANDKLIPPAREN_ASSESSMENT_DEADLINE_MS: "30000",
    BRANDKLIPPAREN_ASSESSMENT_MAX_INPUT_BYTES: "20000",
    BRANDKLIPPAREN_ASSESSMENT_MAX_OUTPUT_BYTES: "4000",
    BRANDKLIPPAREN_ASSESSMENT_MAX_CONCURRENCY: "2",
    BRANDKLIPPAREN_DEMO_PUBLIC_URL: "https://demo.example.invalid",
    BRANDKLIPPAREN_CACHE_DIR: "cache/demo",
    BRANDKLIPPAREN_API_KEY_PEPPER: "fake-pepper-for-tests-only",
    BRANDKLIPPAREN_RATE_LIMIT_PER_KEY_PER_MINUTE: "60",
    BRANDKLIPPAREN_QUOTA_PER_KEY_PER_DAY: "1000",
    BRANDKLIPPAREN_GLOBAL_RATE_PER_MINUTE: "600",
    BRANDKLIPPAREN_BUDGET_DAILY_CAP_RPC_CALLS: "100000",
    BRANDKLIPPAREN_BUDGET_PER_KEY_DAILY_CAP_RPC_CALLS: "10000",
    BRANDKLIPPAREN_BUDGET_DAILY_CAP_ASSESSMENT_CALLS: "1000",
    BRANDKLIPPAREN_BUDGET_DAILY_CAP_ASSESSMENT_CALLS_META: "500",
    BRANDKLIPPAREN_BUDGET_DAILY_CAP_ASSESSMENT_CALLS_hosted: "500",
    BRANDKLIPPAREN_BUDGET_PER_KEY_DAILY_CAP_ASSESSMENT_CALLS: "100",
    BRANDKLIPPAREN_ASSESSMENT_DAILY_COST_CAP_META: "50",
    BRANDKLIPPAREN_ASSESSMENT_DAILY_COST_CAP_hosted: "50",
    BRANDKLIPPAREN_ALARM_LEVELS_PERCENT: "50,80,95",
    BRANDKLIPPAREN_ASSESSMENT_PROMPT_VERSION: "1.0.0",
  };
}

function demoMetaEnv(): Record<string, string | undefined> {
  return {
    ...sharedDemoEnv(),
    BRANDKLIPPAREN_ASSESSMENT_PROVIDER: "meta-model-api",
    BRANDKLIPPAREN_ASSESSMENT_META_API_KEY: "fake-meta-key-for-tests-only",
    BRANDKLIPPAREN_ASSESSMENT_META_MODEL_ID: "fake-meta-spark-1",
    BRANDKLIPPAREN_ASSESSMENT_META_BASE_URL: "https://meta-api.example.invalid",
  };
}

function demohostedEnv(): Record<string, string | undefined> {
  return {
    ...sharedDemoEnv(),
    BRANDKLIPPAREN_ASSESSMENT_PROVIDER: "hosted-open-weights",
    BRANDKLIPPAREN_ASSESSMENT_hosted_API_KEY: "fake-hosted-key-for-tests-only",
    BRANDKLIPPAREN_ASSESSMENT_hosted_MODEL_ID: "fake-open-weights-1",
    BRANDKLIPPAREN_ASSESSMENT_hosted_BASE_URL: "https://hosted.example.invalid",
    BRANDKLIPPAREN_ASSESSMENT_hosted_DEPLOYMENT_ID: "fake-deployment-1",
  };
}

function demoGenericCompatibleEnv(): Record<string, string | undefined> {
  return {
    ...sharedDemoEnv(),
    BRANDKLIPPAREN_ASSESSMENT_PROVIDER: "generic-compatible",
    BRANDKLIPPAREN_ASSESSMENT_generic_COMPATIBLE_API_KEY: "fake-compat-key-for-tests-only",
    BRANDKLIPPAREN_ASSESSMENT_generic_COMPATIBLE_MODEL_ID: "fake-compat-model-1",
    BRANDKLIPPAREN_ASSESSMENT_generic_COMPATIBLE_BASE_URL: "https://compat.example.invalid",
  };
}

function manualBaseConfig(): AppConfig {
  return {
    env: "ci",
    modelVersion: mustOk(ModelVersion.parse("0.1.0")),
    modelArtifactPath: "model/artifact-0.1.0.json",
    cloneIndexVersion: mustOk(IndexVersion.parse("1.0.0")),
    logLevel: "info",
  };
}

describe("composition-root assessment provider selection (K-309)", () => {
  test("k309_config_selects_exactly_one_assessment_adapter", () => {
    const cases = [
      {
        env: demoMetaEnv(),
        provider: "meta-model-api",
        modelId: "fake-meta-spark-1",
        pluginId: "dev.brandklipparen.assessment.meta-model-api",
      },
      {
        env: demohostedEnv(),
        provider: "hosted-open-weights",
        modelId: "fake-open-weights-1",
        pluginId: "dev.brandklipparen.assessment.hosted-open-weights",
      },
      {
        env: demoGenericCompatibleEnv(),
        provider: "generic-compatible",
        modelId: "fake-compat-model-1",
        pluginId: "dev.brandklipparen.assessment.generic-compatible",
      },
    ] as const;
    for (const { env, provider, modelId, pluginId } of cases) {
      const loaded = loadConfig(env);
      expect(loaded.ok).toBe(true);
      if (!loaded.ok) {
        continue;
      }
      const binding = selectAssessmentBinding(loaded.value);
      expect(binding.ok).toBe(true);
      if (!binding.ok) {
        continue;
      }
      expect(binding.value.kind).toBe("enabled");
      if (binding.value.kind !== "enabled") {
        continue;
      }
      expect(binding.value.provider).toBe(provider);
      expect(binding.value.modelId).toBe(modelId);
      expect(binding.value.pluginId).toBe(pluginId);
      expect(assessmentHealthStatus(binding.value)).toEqual({ provider, modelId });
    }
  });

  test("k309_config_selects_exactly_one_assessment_plugin_by_plugin_id", () => {
    const cases = [
      {
        env: demoMetaEnv(),
        pluginId: "dev.brandklipparen.assessment.meta-model-api",
        otherId: "dev.brandklipparen.assessment.hosted-open-weights",
      },
      {
        env: demohostedEnv(),
        pluginId: "dev.brandklipparen.assessment.hosted-open-weights",
        otherId: "dev.brandklipparen.assessment.meta-model-api",
      },
      {
        env: demoGenericCompatibleEnv(),
        pluginId: "dev.brandklipparen.assessment.generic-compatible",
        otherId: "dev.brandklipparen.assessment.hosted-open-weights",
      },
    ] as const;
    for (const { env, pluginId, otherId } of cases) {
      const loaded = loadConfig(env);
      expect(loaded.ok).toBe(true);
      if (!loaded.ok) {
        continue;
      }
      const binding = selectAssessmentBinding(loaded.value);
      expect(binding.ok).toBe(true);
      if (!binding.ok) {
        continue;
      }
      expect(binding.value.kind).toBe("enabled");
      if (binding.value.kind !== "enabled") {
        continue;
      }
      expect(activeAssessmentPluginId(binding.value)).toBe(pluginId);
      const table = assessmentPluginTable(ASSESSMENT_PLUGINS);
      const active = getAssessmentPlugin(table, pluginId);
      expect(active?.manifest.id).toBe(pluginId);
      expect(active?.manifest.kind).toBe("assessment");
      expect(ASSESSMENT_PLUGINS.some((entry) => entry.manifest.id === pluginId)).toBe(true);
      expect(activeAssessmentPluginId(binding.value)).not.toBe(otherId);
    }
    expect(ASSESSMENT_PLUGINS.length).toBe(3);
  });

  test("k309_no_provider_disables_assessment", () => {
    const loaded = loadConfig(baseCiEnv());
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) {
      return;
    }
    const binding = selectAssessmentBinding(loaded.value);
    expect(binding.ok).toBe(true);
    if (!binding.ok) {
      return;
    }
    expect(binding.value).toEqual({ kind: "disabled" });
    expect(assessmentHealthStatus(binding.value)).toEqual({ disabled: true });
  });

  test("s135_provider_without_model_id_disables_assessment", () => {
    for (const provider of ["meta-model-api", "hosted-open-weights", "generic-compatible"] as const) {
      const binding = selectAssessmentBinding({
        ...manualBaseConfig(),
        assessmentProvider: provider,
      });
      expect(binding.ok).toBe(true);
      if (!binding.ok) {
        continue;
      }
      expect(binding.value).toEqual({ kind: "disabled" });
      expect(assessmentHealthStatus(binding.value)).toEqual({ disabled: true });
    }
  });

  test("k309_credentials_without_provider_are_ambiguous_naming_the_variable", () => {
    const secret = "fake-meta-key-for-tests-only";
    const binding = selectAssessmentBinding({
      ...manualBaseConfig(),
      assessmentMetaApiKey: new SecretString(secret),
    });
    expect(binding.ok).toBe(false);
    if (binding.ok) {
      return;
    }
    expect(binding.error.variable).toBe("BRANDKLIPPAREN_ASSESSMENT_PROVIDER");
    const text = formatConfigError(binding.error);
    expect(text).toContain("BRANDKLIPPAREN_ASSESSMENT_PROVIDER");
    expect(text.includes(secret)).toBe(false);
  });
});

describe("default assessment intent is hosted open-weights (S-029, K-309)", () => {
  test("s029_default_provider_is_hosted_open_weights", () => {
    expect(DEFAULT_ASSESSMENT_PROVIDER).toBe("hosted-open-weights");
    expect(DEFAULT_hosted_MODEL_ID).toBe("meta-models/muse-spark-open-1026");
  });

  test("k309_missing_assessment_key_disables_assessment", () => {
    const services = stubServices();
    const cases: readonly AppConfig[] = [
      {
        ...manualBaseConfig(),
        assessmentProvider: "hosted-open-weights",
        assessmenthostedModelId: mustOk(ModelId.parse("meta-models/muse-spark-open-1026")),
        assessmenthostedBaseUrl: "https://hosted.example.invalid",
      },
      {
        ...manualBaseConfig(),
        assessmentProvider: "meta-model-api",
        assessmentMetaModelId: mustOk(ModelId.parse("fake-meta-spark-1")),
        assessmentMetaBaseUrl: "https://meta-api.example.invalid",
      },
      {
        ...manualBaseConfig(),
        assessmentProvider: "generic-compatible",
        assessmentGenericCompatibleModelId: mustOk(ModelId.parse("fake-compat-model-1")),
        assessmentGenericCompatibleBaseUrl: "https://compat.example.invalid",
      },
    ];
    for (const config of cases) {
      const built = createAssessmentServiceFromConfig(config, services);
      expect(built.ok).toBe(true);
      if (!built.ok) {
        continue;
      }
      expect(built.value.provider).toBeNull();
      expect(built.value.modelId).toBeNull();
    }
  });
});

function stubServices(): AppServices {
  const unused = (): never => {
    throw new Error("stub service must not be called on the disabled path");
  };
  return { analyzeToken: unused, resolveProxy: unused };
}
