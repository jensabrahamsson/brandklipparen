// Tests for S-004 (K-505, K-510): typed config and secret handling at startup.
// Written first (red) per A-21; the implementation lives in
// src/ports/config.ts and src/adapters/config/loader.ts.
import { mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { inspect } from "node:util";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import * as fc from "fast-check";
import { formatConfigError } from "../../../src/ports/config.ts";
import type { AppConfig } from "../../../src/ports/config.ts";
import { CONFIG_VARIABLE_NAMES, loadConfig } from "../../../src/adapters/config/loader.ts";
import {
  assessmentHealthStatus,
  createAssessmentServiceFromConfig,
  selectAssessmentBinding,
} from "../../../src/composition/root.ts";
import type { AppServices } from "../../../src/application/analyzeToken.ts";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

function configSources(directory: string): string[] {
  return readdirSync(directory)
    .map((entry) => join(directory, entry))
    .flatMap((path) => (statSync(path).isDirectory() ? configSources(path) : [path]))
    .filter((path) => path.endsWith(".ts"));
}

type EnvInput = Record<string, string | undefined>;

// Minimal valid environment for the ci setup: only the variables that
// I-08 requires in every setup are present.
function baseCiEnv(): EnvInput {
  return {
    BRANDKLIPPAREN_ENV: "ci",
    BRANDKLIPPAREN_MODEL_VERSION: "0.1.0",
    BRANDKLIPPAREN_MODEL_ARTIFACT_PATH: "model/artifact-0.1.0.json",
    BRANDKLIPPAREN_CLONE_INDEX_VERSION: "1.0.0",
    BRANDKLIPPAREN_LOG_LEVEL: "info",
  };
}

// Obviously fake values for the demo setup. Nothing here is a real key,
// URL or secret; the shapes are valid so parsing succeeds.
function demoEnv(): EnvInput {
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
    BRANDKLIPPAREN_BUDGET_PER_KEY_DAILY_CAP_ASSESSMENT_CALLS: "100",
    BRANDKLIPPAREN_ASSESSMENT_PROVIDER: "meta-model-api",
    BRANDKLIPPAREN_ASSESSMENT_PROMPT_VERSION: "1.0.0",
    BRANDKLIPPAREN_ASSESSMENT_META_API_KEY: "fake-meta-key-for-tests-only",
    BRANDKLIPPAREN_ASSESSMENT_META_MODEL_ID: "muse-spark",
    BRANDKLIPPAREN_ASSESSMENT_META_BASE_URL: "https://meta-api.example.invalid",
  };
}

describe("vendor-neutral provider for local development", () => {
  const COMPAT_KEY = "BRANDKLIPPAREN_ASSESSMENT_generic_COMPATIBLE_API_KEY";
  const COMPAT_MODEL = "BRANDKLIPPAREN_ASSESSMENT_generic_COMPATIBLE_MODEL_ID";
  const COMPAT_URL = "BRANDKLIPPAREN_ASSESSMENT_generic_COMPATIBLE_BASE_URL";

  function compatDemoEnv(): EnvInput {
    const env = demoEnv();
    delete env["BRANDKLIPPAREN_ASSESSMENT_META_API_KEY"];
    delete env["BRANDKLIPPAREN_ASSESSMENT_META_MODEL_ID"];
    delete env["BRANDKLIPPAREN_ASSESSMENT_META_BASE_URL"];
    return {
      ...env,
      BRANDKLIPPAREN_ASSESSMENT_PROVIDER: "generic-compatible",
      BRANDKLIPPAREN_ASSESSMENT_PROMPT_VERSION: "1.0.0",
      [COMPAT_KEY]: "fake-compat-key-for-tests-only",
      [COMPAT_MODEL]: "fake-compat-model-1",
      [COMPAT_URL]: "https://compat.example.invalid",
    };
  }

  test("generic-compatible is accepted with all three values", () => {
    const loaded = loadConfig(compatDemoEnv());
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) {
      return;
    }
    expect(loaded.value.assessmentProvider).toBe("generic-compatible");
    expect(loaded.value.assessmentGenericCompatibleApiKey?.reveal()).toBe(
      "fake-compat-key-for-tests-only",
    );
    expect(loaded.value.assessmentGenericCompatibleBaseUrl).toBe("https://compat.example.invalid");
  });

  test("generic-compatible loads with the assessment off when any value is missing (S-135)", () => {
    for (const variable of [COMPAT_KEY, COMPAT_MODEL, COMPAT_URL]) {
      const env = compatDemoEnv();
      delete env[variable];
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
      expect(binding.value).toEqual({ kind: "disabled" });
    }
  });

  test("generic-compatible rejects a non-https base URL without values", () => {
    const env = compatDemoEnv();
    env[COMPAT_URL] = "http://compat.example.invalid";
    const loaded = loadConfig(env);
    expect(loaded.ok).toBe(false);
    if (!loaded.ok) {
      expect(loaded.error.variable).toBe(COMPAT_URL);
      const text = formatConfigError(loaded.error);
      expect(text).toContain(COMPAT_URL);
      expect(text.includes("fake-compat-key-for-tests-only")).toBe(false);
    }
  });

  test("generic-compatible key is redacted in dumps and logs", () => {
    const loaded = loadConfig(compatDemoEnv());
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) {
      return;
    }
    const secret = loaded.value.assessmentGenericCompatibleApiKey;
    expect(secret).toBeDefined();
    if (secret === undefined) {
      return;
    }
    expect(secret.reveal()).toBe("fake-compat-key-for-tests-only");
    expect(String(secret)).toBe("[REDACTED]");
    expect(JSON.stringify(secret)).toBe('"[REDACTED]"');
    expect(inspect(secret)).toContain("[REDACTED]");
    expect(inspect(secret).includes("fake-compat-key-for-tests-only")).toBe(false);
    const serialized = JSON.stringify(loaded.value);
    expect(serialized).toContain("[REDACTED]");
    expect(serialized.includes("fake-compat-key-for-tests-only")).toBe(false);
  });

  test("generic-compatible triple stays optional outside the demo", () => {
    const loaded = loadConfig({
      ...baseCiEnv(),
      BRANDKLIPPAREN_ASSESSMENT_PROVIDER: "generic-compatible",
      [COMPAT_KEY]: "fake-compat-key-for-tests-only",
      [COMPAT_MODEL]: "fake-compat-model-1",
      [COMPAT_URL]: "https://compat.example.invalid",
    });
    expect(loaded.ok).toBe(true);
    const bare = loadConfig(baseCiEnv());
    expect(bare.ok).toBe(true);
  });
});

describe("typed config and secret handling at startup (K-505, K-510)", () => {
  test("k505_missing_variable_named_without_values", () => {
    const secrets: string[] = [
      "fake-meta-key-for-tests-only",
      "fake-pepper-for-tests-only",
      "https://rpc.example.invalid",
    ];
    // Every required variable, removed one at a time: the startup error
    // names the variable and carries no values at all.
    const required = Object.keys(baseCiEnv());
    expect(required.length).toBeGreaterThan(0);
    for (const variable of required) {
      const env = baseCiEnv();
      delete env[variable];
      const loaded = loadConfig(env);
      expect(loaded.ok).toBe(false);
      if (loaded.ok) {
        continue;
      }
      const text = formatConfigError(loaded.error);
      expect(text).toContain(variable);
      for (const secret of secrets) {
        expect(text.includes(secret)).toBe(false);
      }
    }

    // Invalid values (including secrets) name the variable without values.
    const bad: EnvInput = {
      ...demoEnv(),
      BRANDKLIPPAREN_ENV: "no-such-env",
      BRANDKLIPPAREN_ASSESSMENT_META_API_KEY: "",
      BRANDKLIPPAREN_ASSESSMENT_META_BASE_URL: "http://not-https.example.invalid",
    };
    const loaded = loadConfig(bad);
    expect(loaded.ok).toBe(false);
    if (!loaded.ok) {
      const text = formatConfigError(loaded.error);
      expect(text).toContain("BRANDKLIPPAREN_ENV");
      for (const value of Object.values(bad)) {
        if (typeof value === "string" && value.length > 0) {
          expect(text.includes(value)).toBe(false);
        }
      }
    }

    // An empty secret is a missing value, still named without values.
    const emptySecret = demoEnv();
    emptySecret["BRANDKLIPPAREN_API_KEY_PEPPER"] = "";
    const emptyLoaded = loadConfig(emptySecret);
    expect(emptyLoaded.ok).toBe(false);
    if (!emptyLoaded.ok) {
      const text = formatConfigError(emptyLoaded.error);
      expect(text).toContain("BRANDKLIPPAREN_API_KEY_PEPPER");
      expect(text.includes("fake-pepper-for-tests-only")).toBe(false);
    }
  });

  test("k505_keys_read_from_environment_at_start", () => {
    // Keys come from the injected environment object: two different inputs
    // give two different parsed configs, so the loader reads its input.
    const first = loadConfig(demoEnv());
    const secondEnv = demoEnv();
    secondEnv["BRANDKLIPPAREN_ASSESSMENT_META_API_KEY"] = "another-fake-meta-key";
    secondEnv["BRANDKLIPPAREN_API_KEY_PEPPER"] = "another-fake-pepper";
    const second = loadConfig(secondEnv);
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (first.ok && second.ok) {
      expect(first.value.assessmentMetaApiKey?.reveal()).toBe("fake-meta-key-for-tests-only");
      expect(second.value.assessmentMetaApiKey?.reveal()).toBe("another-fake-meta-key");
      expect(second.value.apiKeyPepper?.reveal()).toBe("another-fake-pepper");
    }

    // The injected object wins over the real process environment, so the
    // loader never falls back to ambient values.
    const decoy = "decoy-value-from-process-env";
    process.env["BRANDKLIPPAREN_ASSESSMENT_META_API_KEY"] = decoy;
    try {
      const injected = demoEnv();
      injected["BRANDKLIPPAREN_ASSESSMENT_META_API_KEY"] = "injected-fake-key";
      const loaded = loadConfig(injected);
      expect(loaded.ok).toBe(true);
      if (loaded.ok) {
        expect(loaded.value.assessmentMetaApiKey?.reveal()).toBe("injected-fake-key");
      }
    } finally {
      delete process.env["BRANDKLIPPAREN_ASSESSMENT_META_API_KEY"];
    }
  });

  test("k505_secrets_redact_on_print_and_serialize", () => {
    const loaded = loadConfig(demoEnv());
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) {
      return;
    }
    const secret = loaded.value.assessmentMetaApiKey;
    expect(secret).toBeDefined();
    if (secret === undefined) {
      return;
    }
    expect(secret.reveal()).toBe("fake-meta-key-for-tests-only");
    expect(String(secret)).toBe("[REDACTED]");
    expect(`${secret}`).toBe("[REDACTED]");
    expect(JSON.stringify(secret)).toBe('"[REDACTED]"');
    expect(inspect(secret)).toContain("[REDACTED]");
    expect(inspect(secret).includes("fake-meta-key-for-tests-only")).toBe(false);
    const serialized = JSON.stringify(loaded.value);
    expect(serialized).toContain("[REDACTED]");
    expect(serialized.includes("fake-meta-key-for-tests-only")).toBe(false);
    expect(serialized.includes("fake-pepper-for-tests-only")).toBe(false);
    expect(serialized.includes("https://rpc.example.invalid")).toBe(false);
  });

  test("k505_loaded_config_is_frozen", () => {
    const loaded = loadConfig(demoEnv());
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) {
      return;
    }
    expect(Object.isFrozen(loaded.value)).toBe(true);
    if (loaded.value.rpcUrls !== undefined) {
      expect(Object.isFrozen(loaded.value.rpcUrls)).toBe(true);
      for (const url of loaded.value.rpcUrls) {
        expect(Object.isFrozen(url)).toBe(true);
      }
    }
  });

  test("k505_config_loader_reads_nothing_but_its_input", () => {
    // Boundary: the loader and its port take the environment as an injected
    // object and read nothing else. No process.env, no filesystem, no
    // network, no node: modules. Fails CI when violated.
    const files = [
      ...configSources(join(repoRoot, "src", "adapters", "config")),
      join(repoRoot, "src", "ports", "config.ts"),
    ];
    expect(files.length).toBeGreaterThan(0);
    const forbidden: ReadonlyArray<readonly [RegExp, string]> = [
      [/\bprocess\b/, "process (ambient environment access)"],
      [/from\s+["']node:/, "node: module import"],
      [/\bDate\b/, "Date (system clock)"],
      [/Math\.random/, "Math.random (unseeded randomness)"],
      [/\bfetch\s*\(/, "fetch (network)"],
      [/readFile|writeFile|createReadStream|\.env\b/, "filesystem or .env read"],
      [/\brequire\s*\(/, "require (module loading)"],
    ];
    const violations: string[] = [];
    for (const file of files) {
      const content = readFileSync(file, "utf8");
      const code = content.replace(/^\s*\/\/.*$/gm, "");
      for (const [pattern, label] of forbidden) {
        if (pattern.test(code)) {
          violations.push(`${file}: forbidden ${label}`);
        }
      }
      for (const match of code.matchAll(/from\s+["']([^"']+)["']/g)) {
        const specifier = match[1] ?? "";
        if (!specifier.startsWith(".")) {
          violations.push(`${file}: non-relative import ${specifier}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  test("i08_env_example_has_names_only", () => {
    // The committed example carries the schema's variable names with empty
    // value fields and nothing else (I-08, M-11).
    const example = readFileSync(join(repoRoot, ".env.example"), "utf8");
    const names = new Set<string>();
    for (const line of example.split("\n")) {
      const trimmed = line.trim();
      if (trimmed === "" || trimmed.startsWith("#")) {
        continue;
      }
      const match = /^((?:BRANDKLIPPAREN|BK)_[A-Z0-9_]+|ETHERSCAN_API_KEY)=$/.exec(trimmed);
      expect(match).not.toBeNull();
      names.add(match?.[1] ?? "");
    }
    expect(names).toEqual(new Set(CONFIG_VARIABLE_NAMES));
  });

  test("k505_secret_values_never_appear_in_errors_or_serialized_config", () => {
    const secretValue = fc
      .stringMatching(/^[A-Za-z0-9_-]{16}$/)
      .map((tail) => `test-secret-${tail}`);
    fc.assert(
      fc.property(
        fc.record({
          pepper: secretValue,
          metaKey: secretValue,
          hostedKey: secretValue,
          rpcUrl: fc.constant("https://rpc.example.invalid"),
          dropOne: fc.option(
            fc.constantFrom(
              "BRANDKLIPPAREN_ENV",
              "BRANDKLIPPAREN_MODEL_VERSION",
              "BRANDKLIPPAREN_CLONE_INDEX_VERSION",
              "BRANDKLIPPAREN_LOG_LEVEL",
              "BRANDKLIPPAREN_ASSESSMENT_META_API_KEY",
            ),
            { nil: undefined },
          ),
          breakEnv: fc.boolean(),
        }),
        (draw) => {
          const env: EnvInput = {
            ...demoEnv(),
            BRANDKLIPPAREN_ENV: draw.breakEnv ? "broken-env-value" : "demo",
            BRANDKLIPPAREN_API_KEY_PEPPER: draw.pepper,
            BRANDKLIPPAREN_ASSESSMENT_META_API_KEY: draw.metaKey,
            BRANDKLIPPAREN_ASSESSMENT_hosted_API_KEY: draw.hostedKey,
          };
          if (draw.dropOne !== undefined) {
            delete env[draw.dropOne];
          }
          const candidates = [draw.pepper, draw.metaKey, draw.hostedKey];
          const texts: string[] = [];
          const loaded = loadConfig(env);
          if (loaded.ok) {
            texts.push(JSON.stringify(loaded.value));
            texts.push(inspect(loaded.value));
          } else {
            texts.push(formatConfigError(loaded.error));
          }
          for (const candidate of candidates) {
            for (const text of texts) {
              expect(text.includes(candidate)).toBe(false);
            }
          }
        },
      ),
      { seed: 505, numRuns: 100 },
    );
  });
});

describe("demo provider without key or model id means assessment off (S-135)", () => {
  const META_VARS = [
    "BRANDKLIPPAREN_ASSESSMENT_META_API_KEY",
    "BRANDKLIPPAREN_ASSESSMENT_META_MODEL_ID",
    "BRANDKLIPPAREN_ASSESSMENT_META_BASE_URL",
  ] as const;

  const hosted_VARS = [
    "BRANDKLIPPAREN_ASSESSMENT_hosted_API_KEY",
    "BRANDKLIPPAREN_ASSESSMENT_hosted_MODEL_ID",
    "BRANDKLIPPAREN_ASSESSMENT_hosted_BASE_URL",
    "BRANDKLIPPAREN_ASSESSMENT_hosted_DEPLOYMENT_ID",
  ] as const;

  const COMPAT_VARS = [
    "BRANDKLIPPAREN_ASSESSMENT_generic_COMPATIBLE_API_KEY",
    "BRANDKLIPPAREN_ASSESSMENT_generic_COMPATIBLE_MODEL_ID",
    "BRANDKLIPPAREN_ASSESSMENT_generic_COMPATIBLE_BASE_URL",
  ] as const;

  function withoutProviderTriple(
    provider: "meta-model-api" | "hosted-open-weights" | "generic-compatible",
  ): EnvInput {
    const env: EnvInput = {
      ...demoEnv(),
      BRANDKLIPPAREN_ASSESSMENT_PROVIDER: provider,
    };
    for (const name of [...META_VARS, ...hosted_VARS, ...COMPAT_VARS]) {
      delete env[name];
    }
    return env;
  }

  function withProviderTriple(
    provider: "meta-model-api" | "hosted-open-weights" | "generic-compatible",
    triple: Record<string, string>,
  ): EnvInput {
    const env: EnvInput = {
      ...demoEnv(),
      BRANDKLIPPAREN_ASSESSMENT_PROVIDER: provider,
    };
    for (const name of [...META_VARS, ...hosted_VARS, ...COMPAT_VARS]) {
      delete env[name];
    }
    return { ...env, ...triple };
  }

  function stubServices(): AppServices {
    const unused = (): never => {
      throw new Error("stub service must not be called on the disabled path");
    };
    return { analyzeToken: unused, resolveProxy: unused };
  }

  // Both startup gates in src/main.ts (loadConfig, then buildApp through
  // createAssessmentServiceFromConfig) must pass with the assessment
  // disabled, so the REST process starts, reports assessment off and
  // keeps serving the deterministic analysis.
  function expectAssessmentOff(env: EnvInput): AppConfig {
    const loaded = loadConfig(env);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) {
      throw new Error(`expected loadConfig to pass, got: ${formatConfigError(loaded.error)}`);
    }
    const binding = selectAssessmentBinding(loaded.value);
    expect(binding.ok).toBe(true);
    if (!binding.ok) {
      return loaded.value;
    }
    expect(binding.value).toEqual({ kind: "disabled" });
    expect(assessmentHealthStatus(binding.value)).toEqual({ disabled: true });
    const built = createAssessmentServiceFromConfig(loaded.value, stubServices());
    expect(built.ok).toBe(true);
    if (!built.ok) {
      return loaded.value;
    }
    expect(built.value.provider).toBeNull();
    expect(built.value.modelId).toBeNull();
    return loaded.value;
  }

  test("s135_demo_absent_assessment_key_means_off", () => {
    // hosted open-weights selected with no model id and no key: the REST
    // process starts and reports assessment off instead of exiting with
    // "missing required variable".
    expectAssessmentOff(withoutProviderTriple("hosted-open-weights"));
    // Model id absent while the key is present still means off.
    expectAssessmentOff(
      withProviderTriple("hosted-open-weights", {
        BRANDKLIPPAREN_ASSESSMENT_hosted_API_KEY: "fake-hosted-key-for-tests-only",
        BRANDKLIPPAREN_ASSESSMENT_hosted_BASE_URL: "https://hosted.example.invalid",
        BRANDKLIPPAREN_ASSESSMENT_hosted_DEPLOYMENT_ID: "fake-deployment-1",
      }),
    );
    // Key absent while the model id is present still means off.
    expectAssessmentOff(
      withProviderTriple("hosted-open-weights", {
        BRANDKLIPPAREN_ASSESSMENT_hosted_MODEL_ID: "fake-open-weights-1",
        BRANDKLIPPAREN_ASSESSMENT_hosted_BASE_URL: "https://hosted.example.invalid",
        BRANDKLIPPAREN_ASSESSMENT_hosted_DEPLOYMENT_ID: "fake-deployment-1",
      }),
    );
    // The same absence rule holds for the other two providers.
    expectAssessmentOff(withoutProviderTriple("generic-compatible"));
    expectAssessmentOff(withoutProviderTriple("meta-model-api"));
  });

  test("s135_present_but_malformed_assessment_value_stays_an_error", () => {
    const badUrl = withProviderTriple("hosted-open-weights", {
      BRANDKLIPPAREN_ASSESSMENT_hosted_API_KEY: "fake-hosted-key-for-tests-only",
      BRANDKLIPPAREN_ASSESSMENT_hosted_MODEL_ID: "fake-open-weights-1",
      BRANDKLIPPAREN_ASSESSMENT_hosted_BASE_URL: "http://hosted.example.invalid",
      BRANDKLIPPAREN_ASSESSMENT_hosted_DEPLOYMENT_ID: "fake-deployment-1",
    });
    const loadedUrl = loadConfig(badUrl);
    expect(loadedUrl.ok).toBe(false);
    if (!loadedUrl.ok) {
      expect(loadedUrl.error.variable).toBe("BRANDKLIPPAREN_ASSESSMENT_hosted_BASE_URL");
    }
    const badModel = withProviderTriple("generic-compatible", {
      BRANDKLIPPAREN_ASSESSMENT_generic_COMPATIBLE_API_KEY: "fake-compat-key-for-tests-only",
      BRANDKLIPPAREN_ASSESSMENT_generic_COMPATIBLE_MODEL_ID: `m${"o".repeat(300)}`,
      BRANDKLIPPAREN_ASSESSMENT_generic_COMPATIBLE_BASE_URL: "https://compat.example.invalid",
    });
    const loadedModel = loadConfig(badModel);
    expect(loadedModel.ok).toBe(false);
    if (!loadedModel.ok) {
      expect(loadedModel.error.variable).toBe(
        "BRANDKLIPPAREN_ASSESSMENT_generic_COMPATIBLE_MODEL_ID",
      );
    }
  });

  test("dxb1_market_provider_selection_is_optional_and_validated", () => {
    // Unset stays absent, so local and CI runs keep the listing off.
    const unset = loadConfig(baseCiEnv());
    expect(unset.ok).toBe(true);
    if (unset.ok) {
      expect(unset.value.marketProvider).toBeUndefined();
    }
    for (const provider of ["dexscreener", "off"] as const) {
      const loaded = loadConfig({ ...baseCiEnv(), BRANDKLIPPAREN_MARKET_PROVIDER: provider });
      expect(loaded.ok).toBe(true);
      if (loaded.ok) {
        expect(loaded.value.marketProvider).toBe(provider);
      }
    }
    const bad = loadConfig({ ...baseCiEnv(), BRANDKLIPPAREN_MARKET_PROVIDER: "other" });
    expect(bad.ok).toBe(false);
    if (!bad.ok) {
      expect(bad.error.variable).toBe("BRANDKLIPPAREN_MARKET_PROVIDER");
    }
  });
});

describe("secret file pointers (C-28, F-29)", () => {
  const SECRET_KEY = "BRANDKLIPPAREN_ASSESSMENT_META_API_KEY";
  const SECRET_FILE = "BRANDKLIPPAREN_ASSESSMENT_META_API_KEY_FILE";

  function tempDir(): string {
    return mkdtempSync(join(tmpdir(), "brandklipparen-config-c28-"));
  }

  function fileEnv(name: string, content: string): EnvInput {
    const dir = tempDir();
    const path = join(dir, name);
    writeFileSync(path, content, "utf8");
    return { ...baseCiEnv(), [`${SECRET_KEY}_FILE`]: path };
  }

  function readFile(path: string): string {
    return readFileSync(path, "utf8");
  }

  test("c28_file_secret_resolved_by_loadConfig", () => {
    const loaded = loadConfig(fileEnv("fake-key.txt", "fake-file-key-for-tests-only\n"), {
      readSecretFile: readFile,
    });
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) {
      return;
    }
    expect(loaded.value.assessmentMetaApiKey?.reveal()).toBe("fake-file-key-for-tests-only");
  });

  test("c28_file_secret_trims_crlf_and_rejects_both_set", () => {
    const dir = tempDir();
    const path = join(dir, "fake-key.txt");
    writeFileSync(path, "fake-file-key-for-tests-only\r\n", "utf8");
    const both = loadConfig(
      { ...baseCiEnv(), [SECRET_KEY]: "fake-direct-key", [SECRET_FILE]: path },
      { readSecretFile: readFile },
    );
    expect(both.ok).toBe(false);
    if (!both.ok) {
      expect(both.error.variable).toBe(SECRET_KEY);
      expect(formatConfigError(both.error).includes("fake-direct-key")).toBe(false);
    }
    const trimmed = loadConfig(
      { ...baseCiEnv(), [SECRET_FILE]: path },
      { readSecretFile: readFile },
    );
    expect(trimmed.ok).toBe(true);
    if (trimmed.ok) {
      expect(trimmed.value.assessmentMetaApiKey?.reveal()).toBe("fake-file-key-for-tests-only");
    }
  });

  test("c28_file_secret_missing_file_is_config_error", () => {
    const missing = loadConfig(
      { ...baseCiEnv(), [SECRET_FILE]: join(tempDir(), "absent.txt") },
      { readSecretFile: readFile },
    );
    expect(missing.ok).toBe(false);
    if (!missing.ok) {
      expect(missing.error.variable).toBe(SECRET_FILE);
    }
  });

  test("c28_file_secret_over_size_cap_is_config_error", () => {
    const loaded = loadConfig(fileEnv("big-key.txt", `${"k".repeat(4097)}\n`), {
      readSecretFile: readFile,
    });
    expect(loaded.ok).toBe(false);
    if (!loaded.ok) {
      expect(loaded.error.variable).toBe(SECRET_FILE);
      expect(formatConfigError(loaded.error).includes("k".repeat(16))).toBe(false);
    }
  });

  test("c28_file_secret_at_size_cap_loads", () => {
    const secret = "s".repeat(4096);
    const loaded = loadConfig(fileEnv("capped-key.txt", secret), { readSecretFile: readFile });
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) {
      return;
    }
    expect(loaded.value.assessmentMetaApiKey?.reveal()).toBe(secret);
  });

  test("c28_unknown_FILE_vars_do_not_reach_loadConfig", () => {
    let reads = 0;
    const loaded = loadConfig(
      {
        ...baseCiEnv(),
        BRANDKLIPPAREN_UNKNOWN_FOR_TESTS_FILE: "secrets/unknown.txt",
      },
      {
        readSecretFile: (path) => {
          reads += 1;
          return readFile(path);
        },
      },
    );
    expect(loaded.ok).toBe(true);
    expect(reads).toBe(0);
  });

  test("c28_FILE_pointer_without_reader_stays_unset", () => {
    const loaded = loadConfig({
      ...baseCiEnv(),
      [SECRET_FILE]: join(tempDir(), "unread.txt"),
    });
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) {
      return;
    }
    expect(loaded.value.assessmentMetaApiKey).toBeUndefined();
  });
});
