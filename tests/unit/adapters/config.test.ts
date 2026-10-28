// Tests for S-004 (K-505, K-510): typed config and secret handling at startup.
// Written first (red) per A-21; the implementation lives in
// src/ports/config.ts and src/adapters/config/loader.ts.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { inspect } from "node:util";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import * as fc from "fast-check";
import { formatConfigError } from "../../../src/ports/config.ts";
import { CONFIG_VARIABLE_NAMES, loadConfig } from "../../../src/adapters/config/loader.ts";

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
    BRANDKLIPPAREN_extdecomp_DEADLINE_MS: "5000",
    BRANDKLIPPAREN_extdecomp_MAX_MEMORY_MB: "512",
    BRANDKLIPPAREN_extdecomp_MAX_OUTPUT_BYTES: "100000",
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
    BRANDKLIPPAREN_ASSESSMENT_PROVIDER: "meta-model-api",
    BRANDKLIPPAREN_ASSESSMENT_PROMPT_VERSION: "1.0.0",
    BRANDKLIPPAREN_ASSESSMENT_META_API_KEY: "fake-meta-key-for-tests-only",
    BRANDKLIPPAREN_ASSESSMENT_META_MODEL_ID: "muse-spark",
    BRANDKLIPPAREN_ASSESSMENT_META_BASE_URL: "https://meta-api.example.invalid",
  };
}

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
    if (loaded.value.alarmLevelsPercent !== undefined) {
      expect(Object.isFrozen(loaded.value.alarmLevelsPercent)).toBe(true);
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
              "BRANDKLIPPAREN_extdecomp_DEADLINE_MS",
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
