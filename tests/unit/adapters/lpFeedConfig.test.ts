// Mainnet-only chainId cleanup and feed key wiring (S-091, S-087,
// S-088, K-001, K-039, K-505). Test-first: these tests fail until the
// loader constrains chainId to 1 and reads the feed variables.
import { describe, expect, test } from "vitest";
import { formatConfigError } from "../../../src/ports/config.ts";
import { loadConfig } from "../../../src/adapters/config/loader.ts";

type EnvInput = Record<string, string | undefined>;

function demoEnv(): EnvInput {
  return {
    BRANDKLIPPAREN_ENV: "demo",
    BRANDKLIPPAREN_MODEL_VERSION: "0.1.0",
    BRANDKLIPPAREN_MODEL_ARTIFACT_PATH: "model/artifact-0.1.0.json",
    BRANDKLIPPAREN_CLONE_INDEX_VERSION: "1.0.0",
    BRANDKLIPPAREN_extdecomp_DEADLINE_MS: "5000",
    BRANDKLIPPAREN_extdecomp_MAX_MEMORY_MB: "512",
    BRANDKLIPPAREN_extdecomp_MAX_OUTPUT_BYTES: "100000",
    BRANDKLIPPAREN_LOG_LEVEL: "info",
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

describe("mainnet-only chainId and feed key wiring", () => {
  test("k001_chainid_constrained_to_mainnet", () => {
    const accepted = loadConfig({ ...demoEnv(), BRANDKLIPPAREN_CHAIN_ID: "1" });
    expect(accepted.ok).toBe(true);
    for (const other of ["137", "11155111", "0", "2"]) {
      const rejected = loadConfig({ ...demoEnv(), BRANDKLIPPAREN_CHAIN_ID: other });
      expect(rejected.ok).toBe(false);
      if (!rejected.ok) {
        const text = formatConfigError(rejected.error);
        expect(text).toContain("BRANDKLIPPAREN_CHAIN_ID");
        expect(text).toContain("1");
      }
    }
  });

  test("k039_feed_config_reads_env_keys_without_values_in_errors", () => {
    const loaded = loadConfig({
      ...demoEnv(),
      ETHERSCAN_API_KEY: "fake-etherscan-key-for-tests-only",
      BRANDKLIPPAREN_FEED_RPC_URL: "https://feed-rpc.example.invalid",
      BK_WETH_ADDRESS: "0x774064f309727958148efe603d8aa92896c455bd",
    });
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) {
      return;
    }
    expect(loaded.value.feedEtherscanApiKey?.reveal()).toBe("fake-etherscan-key-for-tests-only");
    expect(loaded.value.feedRpcUrl?.reveal()).toBe("https://feed-rpc.example.invalid");
    expect(loaded.value.feedWethAddress).toBe("0x774064f309727958148EFE603D8Aa92896c455BD");
    const plain = loadConfig(demoEnv());
    expect(plain.ok).toBe(true);
    if (!plain.ok) {
      return;
    }
    expect(plain.value.feedEtherscanApiKey).toBe(undefined);
    expect(plain.value.feedRpcUrl).toBe(undefined);
    expect(plain.value.feedWethAddress).toBe(undefined);
    const badWeth = loadConfig({ ...demoEnv(), BK_WETH_ADDRESS: "not-an-address" });
    expect(badWeth.ok).toBe(false);
    if (!badWeth.ok) {
      const text = formatConfigError(badWeth.error);
      expect(text).toContain("BK_WETH_ADDRESS");
      expect(text.includes("not-an-address")).toBe(false);
    }
  });
});
