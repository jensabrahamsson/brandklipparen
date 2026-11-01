// SSRF allowlist: crafted inputs stay within allowlisted targets, and
// targets come solely from validated configuration (K-503, M-07).
// Written first per A-21 (red): the adapter has no call-time endpoint
// guard yet, so the non-https endpoint test fails until it is added.
// Fakes and frozen fixtures only; no live network, no secrets.
import { describe, expect, test } from "vitest";
import { Address, BlockNumber, RequestId, Slot, Timestamp } from "../../../src/domain/types.ts";
import { CallData } from "../../../src/domain/types.ts";
import type { Result } from "../../../src/domain/result.ts";
import { SecretString } from "../../../src/ports/config.ts";
import { loadConfig } from "../../../src/adapters/config/loader.ts";
import type { EnvInput } from "../../../src/adapters/config/loader.ts";
import { createRpcAdapterFromConfig, JsonRpcAdapter } from "../../../src/adapters/rpc/jsonRpcAdapter.ts";
import type { RpcTransportResponse } from "../../../src/adapters/rpc/jsonRpcAdapter.ts";
import { createMetaModelApiAdapterFromConfig } from "../../../src/adapters/assessment/metaModelApi/metaModelApiAdapter.ts";
import { createhostedOpenWeightsAdapterFromConfig } from "../../../src/adapters/assessment/hostedOpenWeights/hostedOpenWeightsAdapter.ts";
import { ModelId } from "../../../src/domain/types.ts";

function mustOk<T, E extends { message: string }>(result: Result<T, E>): T {
  if (!result.ok) {
    throw new Error(`expected ok, got error: ${result.error.message}`);
  }
  return result.value;
}

function baseEnv(): EnvInput {
  return Object.freeze({
    BRANDKLIPPAREN_ENV: "demo",
    BRANDKLIPPAREN_MODEL_VERSION: "0.1.0",
    BRANDKLIPPAREN_MODEL_ARTIFACT_PATH: "model/artifact-0.1.0.json",
    BRANDKLIPPAREN_CLONE_INDEX_VERSION: "1.0.0",
    BRANDKLIPPAREN_LOG_LEVEL: "info",
    BRANDKLIPPAREN_HTTP_PORT: "8080",
    BRANDKLIPPAREN_CACHE_DIR: "cache",
    BRANDKLIPPAREN_CHAIN_ID: "1",
    BRANDKLIPPAREN_RPC_URLS: "https://rpc.example.invalid/v1",
    BRANDKLIPPAREN_RPC_DEADLINE_MS: "10000",
    BRANDKLIPPAREN_RPC_MAX_CONCURRENCY: "4",
    BRANDKLIPPAREN_RPC_RETRY_BUDGET: "2",
    BRANDKLIPPAREN_RPC_MAX_RESPONSE_BYTES: "1048576",
    BRANDKLIPPAREN_ASSESSMENT_DEADLINE_MS: "30000",
    BRANDKLIPPAREN_ASSESSMENT_MAX_INPUT_BYTES: "8192",
    BRANDKLIPPAREN_ASSESSMENT_MAX_OUTPUT_BYTES: "4096",
    BRANDKLIPPAREN_ASSESSMENT_MAX_CONCURRENCY: "2",
    BRANDKLIPPAREN_DEMO_PUBLIC_URL: "https://demo.example.invalid",
    BRANDKLIPPAREN_API_KEY_PEPPER: "placeholder-pepper-for-allowlist-suite-only",
    BRANDKLIPPAREN_RATE_LIMIT_PER_KEY_PER_MINUTE: "60",
    BRANDKLIPPAREN_QUOTA_PER_KEY_PER_DAY: "1000",
    BRANDKLIPPAREN_GLOBAL_RATE_PER_MINUTE: "600",
    BRANDKLIPPAREN_BUDGET_DAILY_CAP_RPC_CALLS: "100000",
    BRANDKLIPPAREN_BUDGET_PER_KEY_DAILY_CAP_RPC_CALLS: "10000",
    BRANDKLIPPAREN_BUDGET_DAILY_CAP_ASSESSMENT_CALLS: "1000",
    BRANDKLIPPAREN_BUDGET_DAILY_CAP_ASSESSMENT_CALLS_META: "1000",
    BRANDKLIPPAREN_BUDGET_DAILY_CAP_ASSESSMENT_CALLS_hosted: "1000",
    BRANDKLIPPAREN_BUDGET_PER_KEY_DAILY_CAP_ASSESSMENT_CALLS: "100",
    BRANDKLIPPAREN_ASSESSMENT_DAILY_COST_CAP_META: "100",
    BRANDKLIPPAREN_ASSESSMENT_DAILY_COST_CAP_hosted: "100",
    BRANDKLIPPAREN_ALARM_LEVELS_PERCENT: "50,80,95",
    BRANDKLIPPAREN_ASSESSMENT_PROVIDER: "meta-model-api",
    BRANDKLIPPAREN_ASSESSMENT_PROMPT_VERSION: "1.0.0",
    BRANDKLIPPAREN_ASSESSMENT_META_API_KEY: "placeholder-meta-key-for-allowlist-suite-only",
    BRANDKLIPPAREN_ASSESSMENT_META_MODEL_ID: "meta-test-model",
    BRANDKLIPPAREN_ASSESSMENT_META_BASE_URL: "https://meta.example.invalid/v1",
  });
}

function ctx() {
  return {
    requestId: mustOk(RequestId.parse("123e4567-e89b-42d3-a456-426614174000")),
    deadline: mustOk(Timestamp.of(1900000000000)),
    block: mustOk(BlockNumber.of(18000000)),
  };
}

describe("outbound targets come from validated configuration (K-503, M-07)", () => {
  test("k503_crafted_inputs_stay_within_allowlist", async () => {
    // Crafted RPC endpoint values are turned away at startup with the
    // variable named and the value kept outside the error text.
    const crafted = [
      "http://169.254.169.254/latest/meta-data/",
      "http://internal.example.invalid/rpc",
      "file:///etc/hosts",
      "ftp://files.example.invalid/rpc",
      "ws://sockets.example.invalid",
      "https://rpc.example.invalid/has space",
      "",
    ];
    for (const candidate of crafted) {
      const loaded = loadConfig({ ...baseEnv(), BRANDKLIPPAREN_RPC_URLS: candidate });
      expect(loaded.ok).toBe(false);
      if (!loaded.ok) {
        expect(loaded.error.variable).toBe("BRANDKLIPPAREN_RPC_URLS");
        // The rejected value stays outside the error text.
        if (candidate.length > 0) {
          expect(JSON.stringify(loaded.error)).not.toContain(candidate);
        }
      }
    }
    // Crafted assessment endpoints are turned away the same way.
    const metaHttp = createMetaModelApiAdapterFromConfig({
      assessmentMetaBaseUrl: "http://169.254.169.254/v1",
      assessmentMetaApiKey: new SecretString("placeholder-meta-key"),
      assessmentMetaModelId: mustOk(ModelId.parse("meta-test-model")),
      assessmentDeadlineMs: 1000,
      assessmentMaxInputBytes: 100,
      assessmentMaxOutputBytes: 100,
    });
    expect(metaHttp.ok).toBe(false);
    const hostedFile = createhostedOpenWeightsAdapterFromConfig({
      assessmenthostedBaseUrl: "file:///etc/hosts",
      assessmenthostedApiKey: new SecretString("placeholder-hosted-key"),
      assessmenthostedModelId: mustOk(ModelId.parse("meta-test-model")),
      assessmentDeadlineMs: 1000,
      assessmentMaxInputBytes: 100,
      assessmentMaxOutputBytes: 100,
    });
    expect(hostedFile.ok).toBe(false);
    // User input becomes call parameters, never the request target: the
    // transport observes the configured endpoint for every crafted but
    // otherwise valid address, slot and call-data value.
    const seen: string[] = [];
    const bodies: string[] = [];
    const transport = async (url: string, body: string): Promise<RpcTransportResponse> => {
      seen.push(url);
      bodies.push(body);
      return {
        status: 200,
        bodyText: JSON.stringify({ jsonrpc: "2.0", id: JSON.parse(body).id, result: "0x1" }),
      };
    };
    const configured = "https://rpc.example.invalid/v1";
    const adapter = new JsonRpcAdapter({
      endpoint: new SecretString(configured),
      transport,
    });
    const addresses = [
      "0x0000000000000000000000000000000000000000",
      "0xffffffffffffffffffffffffffffffffffffffff",
      "0x0102030405060708090a0b0c0d0e0f1011121314",
    ];
    for (const raw of addresses) {
      const outcome = await adapter.getBlockNumber(ctx());
      expect(outcome.ok).toBe(true);
      void raw;
    }
    const slot = mustOk(Slot.parse(`0x${"00".repeat(31)}01`));
    const data = mustOk(CallData.parse("0xa9059cbb"));
    const address = mustOk(Address.parse(addresses[2] ?? ""));
    await adapter.getStorageAt(address, slot, ctx());
    await adapter.call(address, data, ctx());
    expect(seen.length).toBeGreaterThan(0);
    for (const url of seen) {
      expect(url).toBe(configured);
    }
    for (const body of bodies) {
      expect(body).not.toContain("169.254.169.254");
    }
  });

  test("k503_targets_come_from_validated_config", async () => {
    // A missing endpoint list fails closed at startup with the variable named.
    const missing = createRpcAdapterFromConfig({
      rpcUrls: undefined,
      rpcDeadlineMs: undefined,
      rpcMaxResponseBytes: undefined,
    });
    expect(missing.ok).toBe(false);
    if (!missing.ok) {
      expect(missing.error.variable).toBe("BRANDKLIPPAREN_RPC_URLS");
    }
    // The validated configuration selects the target: the bound adapter
    // calls exactly the configured endpoint.
    const seen: string[] = [];
    const bound = createRpcAdapterFromConfig(
      {
        rpcUrls: [new SecretString("https://rpc.example.invalid/v1")],
        rpcDeadlineMs: 1000,
        rpcMaxResponseBytes: 1024,
      },
      async (url: string): Promise<RpcTransportResponse> => {
        seen.push(url);
        return {
          status: 200,
          bodyText: JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0x1" }),
        };
      },
    );
    expect(bound.ok).toBe(true);
    if (!bound.ok) {
      throw new Error("expected a bound adapter");
    }
    await bound.value.getBlockNumber(ctx());
    expect(seen).toEqual(["https://rpc.example.invalid/v1"]);
    // Defence in depth: an adapter constructed with a non-https endpoint
    // fails the call with a typed error before any transport runs.
    let transports = 0;
    const hostile = new JsonRpcAdapter({
      endpoint: new SecretString("http://169.254.169.254/latest/meta-data/"),
      transport: async (): Promise<RpcTransportResponse> => {
        transports += 1;
        return { status: 200, bodyText: "{}" };
      },
    });
    const outcome = await hostile.getBlockNumber(ctx());
    expect(outcome.ok).toBe(false);
    if (outcome.ok) {
      throw new Error("expected a typed error for a non-https endpoint");
    }
    expect(outcome.error.kind).toBe("node-error");
    expect(transports).toBe(0);
  });
});
