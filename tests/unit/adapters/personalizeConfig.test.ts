// Config loader and composition selection for the experimental AI
// personalize provider (brief 41, S-069, P-27). The toggle is off by
// default, an invalid value is a typed startup error, and a selected
// provider without its key or model id stays not-configured instead of
// failing startup (S-135). No test touches the network.
import { describe, expect, test } from "vitest";
import { loadConfig } from "../../../src/adapters/config/loader.ts";
import { SecretString } from "../../../src/ports/config.ts";
import type { AppConfig } from "../../../src/ports/config.ts";
import type { Result } from "../../../src/domain/result.ts";
import { IndexVersion, ModelVersion } from "../../../src/domain/types.ts";

function mustOk<T>(result: Result<T, { message: string }>): T {
  if (!result.ok) {
    throw new Error(`expected ok, got error: ${result.error.message}`);
  }
  return result.value;
}
import {
  createPersonalizeServiceFromConfig,
  selectPersonalizeBinding,
} from "../../../src/composition/root.ts";

type EnvInput = Record<string, string | undefined>;

function baseCiEnv(): EnvInput {
  return {
    BRANDKLIPPAREN_ENV: "ci",
    BRANDKLIPPAREN_MODEL_VERSION: "0.1.0",
    BRANDKLIPPAREN_MODEL_ARTIFACT_PATH: "model/artifact-0.1.0.json",
    BRANDKLIPPAREN_CLONE_INDEX_VERSION: "1.0.0",
    BRANDKLIPPAREN_LOG_LEVEL: "info",
  };
}

function compatEnv(overrides: EnvInput = {}): EnvInput {
  return {
    ...baseCiEnv(),
    BRANDKLIPPAREN_PERSONALIZE_PROVIDER: "generic-compatible",
    BRANDKLIPPAREN_ASSESSMENT_generic_COMPATIBLE_API_KEY: "fake-compat-key-for-tests-only",
    BRANDKLIPPAREN_ASSESSMENT_generic_COMPATIBLE_MODEL_ID: "fake-compat-model-1",
    BRANDKLIPPAREN_ASSESSMENT_generic_COMPATIBLE_BASE_URL: "https://compat.example.invalid",
    ...overrides,
  };
}

function metaEnv(overrides: EnvInput = {}): EnvInput {
  return {
    ...baseCiEnv(),
    BRANDKLIPPAREN_PERSONALIZE_PROVIDER: "meta-model-api",
    BRANDKLIPPAREN_ASSESSMENT_META_API_KEY: "fake-meta-key-for-tests-only",
    BRANDKLIPPAREN_ASSESSMENT_META_MODEL_ID: "fake-meta-model-1",
    BRANDKLIPPAREN_ASSESSMENT_META_BASE_URL: "https://meta.example.invalid",
    ...overrides,
  };
}

describe("personalize provider configuration", () => {
  test("unset provider leaves the feature off by default", () => {
    const loaded = loadConfig(baseCiEnv());
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) {
      return;
    }
    expect(loaded.value.personalizeProvider).toBeUndefined();
    const binding = selectPersonalizeBinding(loaded.value);
    expect(binding.ok).toBe(true);
    if (!binding.ok) {
      return;
    }
    expect(binding.value).toEqual({ kind: "disabled" });
    const service = createPersonalizeServiceFromConfig(loaded.value);
    expect(service.ok).toBe(true);
    if (!service.ok) {
      return;
    }
    expect(service.value).toBeUndefined();
  });

  test("off disables the feature like an unset provider", () => {
    const loaded = loadConfig(compatEnv({ BRANDKLIPPAREN_PERSONALIZE_PROVIDER: "off" }));
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) {
      return;
    }
    expect(loaded.value.personalizeProvider).toBeUndefined();
    const binding = selectPersonalizeBinding(loaded.value);
    expect(binding.ok).toBe(true);
    if (!binding.ok) {
      return;
    }
    expect(binding.value).toEqual({ kind: "disabled" });
  });

  test("an invalid provider value is a typed startup error", () => {
    const loaded = loadConfig(compatEnv({ BRANDKLIPPAREN_PERSONALIZE_PROVIDER: "unknown-provider" }));
    expect(loaded.ok).toBe(false);
    if (loaded.ok) {
      return;
    }
    expect(loaded.error.variable).toBe("BRANDKLIPPAREN_PERSONALIZE_PROVIDER");
  });

  test("a selected provider without its model id stays not-configured", () => {
    const loaded = loadConfig(
      compatEnv({ BRANDKLIPPAREN_ASSESSMENT_generic_COMPATIBLE_MODEL_ID: "" }),
    );
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) {
      return;
    }
    const binding = selectPersonalizeBinding(loaded.value);
    expect(binding.ok).toBe(true);
    if (!binding.ok) {
      return;
    }
    expect(binding.value).toEqual({ kind: "disabled" });
    const service = createPersonalizeServiceFromConfig(loaded.value);
    expect(service.ok).toBe(true);
    if (!service.ok) {
      return;
    }
    expect(service.value).toBeUndefined();
  });

  test("a selected provider without its key stays not-configured", () => {
    const loaded = loadConfig(
      compatEnv({ BRANDKLIPPAREN_ASSESSMENT_generic_COMPATIBLE_API_KEY: "" }),
    );
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) {
      return;
    }
    const binding = selectPersonalizeBinding(loaded.value);
    expect(binding.ok).toBe(true);
    if (!binding.ok) {
      return;
    }
    expect(binding.value).toEqual({ kind: "disabled" });
    const service = createPersonalizeServiceFromConfig(loaded.value);
    expect(service.ok).toBe(true);
    if (!service.ok) {
      return;
    }
    expect(service.value).toBeUndefined();
  });

  test("a configured triple binds the generic-compatible provider and model honestly", () => {
    const loaded = loadConfig(compatEnv());
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) {
      return;
    }
    expect(loaded.value.personalizeProvider).toBe("generic-compatible");
    const binding = selectPersonalizeBinding(loaded.value);
    expect(binding.ok).toBe(true);
    if (!binding.ok) {
      return;
    }
    expect(binding.value).toEqual({
      kind: "enabled",
      provider: "generic-compatible",
      modelId: "fake-compat-model-1",
    });
    const service = createPersonalizeServiceFromConfig(loaded.value);
    expect(service.ok).toBe(true);
    if (!service.ok || service.value === undefined) {
      throw new Error("expected the personalize service to be wired");
    }
    expect(service.value.provider).toBe("generic-compatible");
    expect(service.value.modelId).toBe("fake-compat-model-1");
  });

  test("a configured meta triple binds the meta-model-api provider and model honestly", () => {
    const loaded = loadConfig(metaEnv());
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) {
      return;
    }
    expect(loaded.value.personalizeProvider).toBe("meta-model-api");
    const binding = selectPersonalizeBinding(loaded.value);
    expect(binding.ok).toBe(true);
    if (!binding.ok) {
      return;
    }
    expect(binding.value).toEqual({
      kind: "enabled",
      provider: "meta-model-api",
      modelId: "fake-meta-model-1",
    });
    const service = createPersonalizeServiceFromConfig(loaded.value);
    expect(service.ok).toBe(true);
    if (!service.ok || service.value === undefined) {
      throw new Error("expected the personalize service to be wired");
    }
    expect(service.value.provider).toBe("meta-model-api");
    expect(service.value.modelId).toBe("fake-meta-model-1");
  });

  test("a meta triple missing its key, model id or endpoint stays not-configured", () => {
    for (const overrides of [
      { BRANDKLIPPAREN_ASSESSMENT_META_API_KEY: "" },
      { BRANDKLIPPAREN_ASSESSMENT_META_MODEL_ID: "" },
      { BRANDKLIPPAREN_ASSESSMENT_META_BASE_URL: "" },
    ]) {
      const loaded = loadConfig(metaEnv(overrides));
      expect(loaded.ok).toBe(true);
      if (!loaded.ok) {
        continue;
      }
      const binding = selectPersonalizeBinding(loaded.value);
      expect(binding.ok).toBe(true);
      if (!binding.ok) {
        continue;
      }
      expect(binding.value).toEqual({ kind: "disabled" });
      const service = createPersonalizeServiceFromConfig(loaded.value);
      expect(service.ok).toBe(true);
      if (!service.ok) {
        continue;
      }
      expect(service.value).toBeUndefined();
    }
  });

  test("a malformed meta endpoint stays a typed startup error", () => {
    const loaded = loadConfig(metaEnv({ BRANDKLIPPAREN_ASSESSMENT_META_BASE_URL: "http://meta.example.invalid" }));
    expect(loaded.ok).toBe(false);
    if (loaded.ok) {
      return;
    }
    expect(loaded.error.variable).toBe("BRANDKLIPPAREN_ASSESSMENT_META_BASE_URL");
  });

  test("selecting hosted keeps the previous unwired behaviour", () => {
    const loaded = loadConfig(compatEnv({ BRANDKLIPPAREN_PERSONALIZE_PROVIDER: "hosted-open-weights" }));
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) {
      return;
    }
    expect(loaded.value.personalizeProvider).toBe("hosted-open-weights");
    const service = createPersonalizeServiceFromConfig(loaded.value);
    expect(service.ok).toBe(true);
    if (!service.ok) {
      return;
    }
    expect(service.value).toBeUndefined();
  });

  test("the daily cap parses and stays optional", () => {
    const unset = loadConfig(compatEnv());
    expect(unset.ok).toBe(true);
    if (!unset.ok) {
      return;
    }
    expect(unset.value.personalizeDailyCapPerKey).toBeUndefined();
    const set = loadConfig(compatEnv({ BRANDKLIPPAREN_PERSONALIZE_DAILY_CAP_PER_KEY: "7" }));
    expect(set.ok).toBe(true);
    if (!set.ok) {
      return;
    }
    expect(set.value.personalizeDailyCapPerKey).toBe(7);
    for (const raw of ["0", "abc"]) {
      const bad = loadConfig(compatEnv({ BRANDKLIPPAREN_PERSONALIZE_DAILY_CAP_PER_KEY: raw }));
      expect(bad.ok).toBe(false);
      if (bad.ok) {
        continue;
      }
      expect(bad.error.variable).toBe("BRANDKLIPPAREN_PERSONALIZE_DAILY_CAP_PER_KEY");
    }
  });

  test("a malformed assessment endpoint stays a typed startup error", () => {
    const loaded = loadConfig(
      compatEnv({ BRANDKLIPPAREN_ASSESSMENT_generic_COMPATIBLE_BASE_URL: "http://compat.example.invalid" }),
    );
    expect(loaded.ok).toBe(false);
    if (loaded.ok) {
      return;
    }
    expect(loaded.error.variable).toBe("BRANDKLIPPAREN_ASSESSMENT_generic_COMPATIBLE_BASE_URL");
  });

  test("credentials without a personalize provider stay disabled", () => {
    const config: AppConfig = {
      env: "ci",
      modelVersion: mustOk(ModelVersion.parse("0.1.0")),
      modelArtifactPath: "model/artifact-0.1.0.json",
      cloneIndexVersion: mustOk(IndexVersion.parse("1.0.0")),
      logLevel: "info",
      assessmentGenericCompatibleApiKey: new SecretString("fake-compat-key-for-tests-only"),
    };
    const binding = selectPersonalizeBinding(config);
    expect(binding.ok).toBe(true);
    if (!binding.ok) {
      return;
    }
    expect(binding.value).toEqual({ kind: "disabled" });
  });
});
