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
  selectAssessmentBinding,
} from "../../src/composition/root.ts";
import { IndexVersion, ModelVersion } from "../../src/domain/types.ts";
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
    BRANDKLIPPAREN_extdecomp_DEADLINE_MS: "5000",
    BRANDKLIPPAREN_extdecomp_MAX_MEMORY_MB: "512",
    BRANDKLIPPAREN_extdecomp_MAX_OUTPUT_BYTES: "100000",
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
    BRANDKLIPPAREN_extdecomp_MAX_CONCURRENCY: "2",
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

function manualBaseConfig(): AppConfig {
  return {
    env: "ci",
    modelVersion: mustOk(ModelVersion.parse("0.1.0")),
    modelArtifactPath: "model/artifact-0.1.0.json",
    cloneIndexVersion: mustOk(IndexVersion.parse("1.0.0")),
    extdecompDeadlineMs: 5000,
    extdecompMaxMemoryMb: 512,
    extdecompMaxOutputBytes: 100000,
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
      },
      {
        env: demohostedEnv(),
        provider: "hosted-open-weights",
        modelId: "fake-open-weights-1",
      },
    ] as const;
    for (const { env, provider, modelId } of cases) {
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
      expect(assessmentHealthStatus(binding.value)).toEqual({ provider, modelId });
    }
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

  test("k309_provider_without_model_id_is_invalid_naming_the_variable", () => {
    const meta = selectAssessmentBinding({
      ...manualBaseConfig(),
      assessmentProvider: "meta-model-api",
    });
    expect(meta.ok).toBe(false);
    if (meta.ok) {
      return;
    }
    expect(meta.error.variable).toBe("BRANDKLIPPAREN_ASSESSMENT_META_MODEL_ID");
    expect(formatConfigError(meta.error)).toContain("BRANDKLIPPAREN_ASSESSMENT_META_MODEL_ID");

    const hosted = selectAssessmentBinding({
      ...manualBaseConfig(),
      assessmentProvider: "hosted-open-weights",
    });
    expect(hosted.ok).toBe(false);
    if (hosted.ok) {
      return;
    }
    expect(hosted.error.variable).toBe("BRANDKLIPPAREN_ASSESSMENT_hosted_MODEL_ID");
    expect(formatConfigError(hosted.error)).toContain(
      "BRANDKLIPPAREN_ASSESSMENT_hosted_MODEL_ID",
    );
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
