// RPC adapter over a recorded transport (S-005, K-001, K-503, K-511).
// Written first per A-21: every test builds the adapter with an injected
// recorded transport that replays the synthetic fixtures under
// tests/fixtures/rpc, so the suite performs zero real network calls.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import {
  JsonRpcAdapter,
  createRpcAdapterFromConfig,
  resolveRpcMaxResponseBytes,
  resolveRpcTimeoutMs,
} from "../../src/adapters/rpc/jsonRpcAdapter.ts";
import type { RpcAdapterConfig } from "../../src/adapters/rpc/jsonRpcAdapter.ts";
import type {
  RpcTransport,
  RpcTransportResponse,
} from "../../src/adapters/rpc/jsonRpcAdapter.ts";
import type { Result } from "../../src/domain/result.ts";
import {
  Address,
  BlockNumber,
  Bytecode,
  CallData,
  RequestId,
  Slot,
  Timestamp,
} from "../../src/domain/types.ts";
import { SecretString } from "../../src/ports/config.ts";
import type { CallContext, RpcError } from "../../src/ports/rpc.ts";

const fixtureRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "rpc");

const RECORDED_ENDPOINT = "https://recorded-rpc.invalid/synthetic-endpoint";
const CONTRACT_ADDRESS = "0x1234567890123456789012345678901234567890";
const EOA_ADDRESS = "0x0987654321098765432109876543210987654321";
const PINNED_BLOCK = 24000000;
const PINNED_BLOCK_HEX = "0x16e3600";

function mustOk<T, E extends { message: string }>(result: Result<T, E>): T {
  if (!result.ok) {
    throw new Error(`expected ok, got error: ${result.error.message}`);
  }
  return result.value;
}

function fixedContext(block: number | "latest" = PINNED_BLOCK): CallContext {
  return {
    requestId: mustOk(RequestId.parse("123e4567-e89b-12d3-a456-426614174000")),
    deadline: mustOk(Timestamp.of(4102444800000)),
    block: block === "latest" ? "latest" : mustOk(BlockNumber.of(block)),
  };
}

function readFixtureResponse(name: string): { result: unknown } {
  const raw = readFileSync(join(fixtureRoot, name), "utf8");
  const parsed = JSON.parse(raw) as { response: { result: unknown } };
  return { result: parsed.response.result };
}

type RecordedCall = { readonly url: string; readonly body: string };

function makeRecordedTransport(results: ReadonlyMap<string, unknown>): {
  transport: RpcTransport;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  const transport: RpcTransport = async (url, body) => {
    calls.push({ url, body });
    const request = JSON.parse(body) as { id: unknown; method: string };
    const result = results.get(request.method);
    if (result === undefined) {
      throw new Error(`unexpected JSON-RPC method: ${request.method}`);
    }
    const payload = { jsonrpc: "2.0", id: request.id, result };
    return { status: 200, bodyText: JSON.stringify(payload) };
  };
  return { transport, calls };
}

function makeAdapter(
  transport: RpcTransport,
  overrides: { timeoutMs?: number; maxResponseBytes?: number } = {},
): JsonRpcAdapter {
  return new JsonRpcAdapter({
    endpoint: new SecretString(RECORDED_ENDPOINT),
    timeoutMs: overrides.timeoutMs ?? 1000,
    maxResponseBytes: overrides.maxResponseBytes ?? 65536,
    transport,
  });
}

function sentPayload(calls: readonly RecordedCall[], index: number): {
  method: string;
  params: readonly unknown[];
} {
  const call = calls[index];
  if (call === undefined) {
    throw new Error("expected a recorded transport call");
  }
  const parsed = JSON.parse(call.body) as { method: string; params: readonly unknown[] };
  return { method: parsed.method, params: parsed.params };
}

function errorOf(result: { ok: boolean; error?: RpcError }): RpcError {
  if (result.ok || result.error === undefined) {
    throw new Error("expected a typed RPC error");
  }
  return result.error;
}

describe("RPC adapter over a recorded transport (K-001)", () => {
  test("k001_contract_address_returns_bytecode", async () => {
    const fixture = readFixtureResponse("getCode-contract.json");
    const { transport, calls } = makeRecordedTransport(
      new Map([["eth_getCode", fixture.result]]),
    );
    const adapter = makeAdapter(transport);
    const address = mustOk(Address.parse(CONTRACT_ADDRESS));
    const result = await adapter.getCode(address, fixedContext(PINNED_BLOCK));
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.value.block as number).toBe(PINNED_BLOCK);
    const expected = mustOk(Bytecode.parse(fixture.result as string));
    expect(Array.from(result.value.bytecode)).toEqual(Array.from(expected));
    // The request carries the pinned block in hex quantity form.
    expect(calls.length).toBe(1);
    expect(sentPayload(calls, 0)).toEqual({
      method: "eth_getCode",
      params: [CONTRACT_ADDRESS, PINNED_BLOCK_HEX],
    });
  });

  test("k001_invalid_address_fails_before_rpc", async () => {
    const { transport, calls } = makeRecordedTransport(new Map());
    const adapter = makeAdapter(transport);
    // Driving adapters validate through Address.parse before the first
    // RPC call (A-11); an invalid address never reaches the transport.
    const parsed = Address.parse("0xnot-an-address");
    if (parsed.ok) {
      await adapter.getCode(parsed.value, fixedContext(PINNED_BLOCK));
    }
    expect(parsed.ok).toBe(false);
    expect(calls.length).toBe(0);
  });

  test("k001_eoa_returns_no_contract_reason", async () => {
    const fixture = readFixtureResponse("getCode-eoa.json");
    const { transport } = makeRecordedTransport(new Map([["eth_getCode", fixture.result]]));
    const adapter = makeAdapter(transport);
    const address = mustOk(Address.parse(EOA_ADDRESS));
    const result = await adapter.getCode(address, fixedContext(PINNED_BLOCK));
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.error.kind).toBe("no-code");
  });

  test("k001_block_lookup_pins_latest_before_getcode", async () => {
    const { transport, calls } = makeRecordedTransport(
      new Map([
        ["eth_blockNumber", PINNED_BLOCK_HEX],
        ["eth_getCode", "0x6001600055"],
      ]),
    );
    const adapter = makeAdapter(transport);
    const address = mustOk(Address.parse(CONTRACT_ADDRESS));
    const result = await adapter.getCode(address, fixedContext("latest"));
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.value.block as number).toBe(PINNED_BLOCK);
    expect(calls.length).toBe(2);
    expect(sentPayload(calls, 0).method).toBe("eth_blockNumber");
    expect(sentPayload(calls, 1)).toEqual({
      method: "eth_getCode",
      params: [CONTRACT_ADDRESS, PINNED_BLOCK_HEX],
    });
  });

  test("k001_expired_deadline_fails_before_transport", async () => {
    const { transport, calls } = makeRecordedTransport(
      new Map([["eth_getCode", "0x6001600055"]]),
    );
    const adapter = makeAdapter(transport);
    const address = mustOk(Address.parse(CONTRACT_ADDRESS));
    const ctx: CallContext = {
      requestId: mustOk(RequestId.parse("123e4567-e89b-12d3-a456-426614174000")),
      deadline: mustOk(Timestamp.of(1000)),
      block: mustOk(BlockNumber.of(PINNED_BLOCK)),
    };
    const result = await adapter.getCode(address, ctx);
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.error.kind).toBe("timeout");
    expect(calls.length).toBe(0);
  });

  test("k001_malformed_response_rejected", async () => {
    const transport: RpcTransport = async () => ({ status: 200, bodyText: "this is not JSON-RPC" });
    const adapter = makeAdapter(transport);
    const address = mustOk(Address.parse(CONTRACT_ADDRESS));
    const result = await adapter.getCode(address, fixedContext(PINNED_BLOCK));
    const error = errorOf(result);
    expect(error.kind).toBe("invalid-response");
    expect(error.message).not.toContain("recorded-rpc.invalid");
  });

  test("k001_oversize_response_rejected", async () => {
    const bodyText = JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0x6001600055" });
    const transport: RpcTransport = async () => ({ status: 200, bodyText });
    const adapter = makeAdapter(transport, { maxResponseBytes: 16 });
    const address = mustOk(Address.parse(CONTRACT_ADDRESS));
    const result = await adapter.getCode(address, fixedContext(PINNED_BLOCK));
    const error = errorOf(result);
    expect(error.kind).toBe("invalid-response");
    expect(error.message).not.toContain("recorded-rpc.invalid");
  });

  test("k001_wrong_id_response_rejected", async () => {
    const transport: RpcTransport = async (_url, body) => {
      const request = JSON.parse(body) as { id: unknown };
      const payload = { jsonrpc: "2.0", id: "mismatched-id-999", result: "0x6001600055" };
      if (request.id === "mismatched-id-999") {
        throw new Error("test setup must not echo the mismatched id");
      }
      return { status: 200, bodyText: JSON.stringify(payload) };
    };
    const adapter = makeAdapter(transport);
    const address = mustOk(Address.parse(CONTRACT_ADDRESS));
    const result = await adapter.getCode(address, fixedContext(PINNED_BLOCK));
    expect(errorOf(result).kind).toBe("invalid-response");
  });

  test("k001_node_error_maps_to_typed_error", async () => {
    const transport: RpcTransport = async (_url, body) => {
      const request = JSON.parse(body) as { id: unknown };
      const payload = {
        jsonrpc: "2.0",
        id: request.id,
        error: { code: -32000, message: "synthetic node failure" },
      };
      return { status: 200, bodyText: JSON.stringify(payload) };
    };
    const adapter = makeAdapter(transport);
    const address = mustOk(Address.parse(CONTRACT_ADDRESS));
    const result = await adapter.getCode(address, fixedContext(PINNED_BLOCK));
    const error = errorOf(result);
    expect(error.kind).toBe("node-error");
    expect(error.message).not.toContain("synthetic node failure");
  });

  test("k001_rate_limited_maps_to_typed_error", async () => {
    const transport: RpcTransport = async () => ({ status: 429, bodyText: "slow down" });
    const adapter = makeAdapter(transport);
    const address = mustOk(Address.parse(CONTRACT_ADDRESS));
    const result = await adapter.getCode(address, fixedContext(PINNED_BLOCK));
    expect(errorOf(result).kind).toBe("rate-limited");
  });

  test("k001_timeout_maps_to_typed_error", async () => {
    const hanging: RpcTransport = async () => new Promise<RpcTransportResponse>(() => {});
    const adapter = makeAdapter(hanging, { timeoutMs: 20 });
    const address = mustOk(Address.parse(CONTRACT_ADDRESS));
    const result = await adapter.getCode(address, fixedContext(PINNED_BLOCK));
    const error = errorOf(result);
    expect(error.kind).toBe("timeout");
    expect(error.message).not.toContain("recorded-rpc.invalid");
  });

  test("k503_user_input_never_becomes_target_url", async () => {
    const { transport, calls } = makeRecordedTransport(
      new Map([
        ["eth_blockNumber", PINNED_BLOCK_HEX],
        ["eth_getCode", "0x6001600055"],
        [
          "eth_getStorageAt",
          "0x0000000000000000000000000000000000000000000000000000000000000001",
        ],
        ["eth_call", "0x"],
      ]),
    );
    const adapter = makeAdapter(transport);
    const address = mustOk(Address.parse(CONTRACT_ADDRESS));
    const ctx = fixedContext(PINNED_BLOCK);
    await adapter.getCode(address, ctx);
    await adapter.getBlockNumber(ctx);
    await adapter.getStorageAt(
      address,
      mustOk(Slot.parse("0x0000000000000000000000000000000000000000000000000000000000000000")),
      ctx,
    );
    await adapter.call(address, mustOk(CallData.parse("0x70a08231")), ctx);
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      expect(call.url).toBe(RECORDED_ENDPOINT);
      expect(call.url).not.toContain("1234567890");
    }
  });

  test("k001_rpc_url_and_key_come_from_config_only", async () => {
    const missing = createRpcAdapterFromConfig({
      rpcUrls: undefined,
      rpcDeadlineMs: undefined,
      rpcMaxResponseBytes: undefined,
    });
    expect(missing.ok).toBe(false);
    if (missing.ok) {
      return;
    }
    expect(missing.error.variable).toBe("BRANDKLIPPAREN_RPC_URLS");
    const present = createRpcAdapterFromConfig(
      {
        rpcUrls: [new SecretString(RECORDED_ENDPOINT)],
        rpcDeadlineMs: 1000,
        rpcMaxResponseBytes: 65536,
      },
      async () => ({ status: 200, bodyText: JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0x16e3600" }) }),
    );
    expect(present.ok).toBe(true);
  });

  test("k001_rpc_limits_resolve_from_config_with_placeholder_defaults", () => {
    expect(resolveRpcTimeoutMs(undefined)).toBeGreaterThan(0);
    expect(resolveRpcMaxResponseBytes(undefined)).toBeGreaterThan(0);
    expect(resolveRpcTimeoutMs(1500)).toBe(1500);
    expect(resolveRpcMaxResponseBytes(4096)).toBe(4096);
  });

  test("k001_recorded_transport_makes_no_network_calls", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (() => {
      throw new Error("real network is disabled in tests");
    }) as typeof fetch;
    try {
      const { transport } = makeRecordedTransport(
        new Map([
          ["eth_blockNumber", PINNED_BLOCK_HEX],
          ["eth_getCode", "0x6001600055"],
        ]),
      );
      const adapter = makeAdapter(transport);
      const address = mustOk(Address.parse(CONTRACT_ADDRESS));
      const code = await adapter.getCode(address, fixedContext(PINNED_BLOCK));
      expect(code.ok).toBe(true);
      const head = await adapter.getBlockNumber(fixedContext(PINNED_BLOCK));
      expect(head.ok).toBe(true);
      if (!head.ok) {
        return;
      }
      expect(head.value as number).toBe(PINNED_BLOCK);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("RPC adapter configuration", () => {
  test("k001_rpc_config_factory_binds_first_url", async () => {
    const seen: string[] = [];
    const recording: RpcTransport = async (url, body) => {
      seen.push(url);
      const request = JSON.parse(body) as { id: unknown; method: string };
      return {
        status: 200,
        bodyText: JSON.stringify({ jsonrpc: "2.0", id: request.id, result: "0x16e3600" }),
      };
    };
    const config = {
      rpcUrls: [new SecretString(RECORDED_ENDPOINT)],
      rpcDeadlineMs: 1000,
      rpcMaxResponseBytes: 65536,
    } satisfies RpcAdapterConfig;
    const created = createRpcAdapterFromConfig(config, recording);
    expect(created.ok).toBe(true);
    if (!created.ok) {
      return;
    }
    const head = await created.value.getBlockNumber(fixedContext(PINNED_BLOCK));
    expect(head.ok).toBe(true);
    expect(seen).toEqual([RECORDED_ENDPOINT]);
  });
});
