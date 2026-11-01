// Mainnet chain verification at startup (S-108, K-001, K-503): the
// process verifies `eth_chainId` is `0x1` once before serving, and a
// transport answering any other chain fails typed so startup blocks.
// Written first (red) per A-21: no chain check exists. No network; the
// transports below answer canned chain ids.
import { describe, expect, test } from "vitest";
import {
  JsonRpcAdapter,
  verifyMainnetChainId,
} from "../../../src/adapters/rpc/jsonRpcAdapter.ts";
import type { RpcTransport } from "../../../src/adapters/rpc/jsonRpcAdapter.ts";
import { BlockNumber, RequestId, Timestamp } from "../../../src/domain/types.ts";
import { SecretString } from "../../../src/ports/config.ts";

function cannedChainId(result: string): RpcTransport {
  return async () => ({
    status: 200,
    bodyText: JSON.stringify({ jsonrpc: "2.0", id: 1, result }),
  });
}

describe("mainnet chain verification (S-108)", () => {
  test("k503_non_mainnet_chain_blocks_startup", async () => {
    const checked = await verifyMainnetChainId(
      "https://example.invalid",
      cannedChainId("0x5"),
      1000,
    );
    if (checked.ok) {
      throw new Error("expected a non-mainnet chain to fail verification");
    }
    expect(checked.error.kind).toBe("chain-mismatch");
  });

  test("sec1_s3_chain_is_rechecked_at_most_once_per_interval_and_fails_closed", async () => {
    let chainResult = "0x1";
    let chainCalls = 0;
    let blockCalls = 0;
    let now = 1_700_000_000_000;
    const transport: RpcTransport = async (_url, body) => {
      const parsed = JSON.parse(body) as { id: number; method: string };
      if (parsed.method === "eth_chainId") {
        chainCalls += 1;
        return {
          status: 200,
          bodyText: JSON.stringify({ jsonrpc: "2.0", id: parsed.id, result: chainResult }),
        };
      }
      blockCalls += 1;
      return {
        status: 200,
        bodyText: JSON.stringify({ jsonrpc: "2.0", id: parsed.id, result: "0x1234" }),
      };
    };
    const adapter = new JsonRpcAdapter({
      endpoint: new SecretString("https://rpc.example.invalid"),
      transport,
      chainRecheckIntervalMs: 600_000,
      nowMs: () => now,
    });
    const requestId = RequestId.parse("123e4567-e89b-42d3-a456-426614174000");
    const deadline = Timestamp.of(1_900_000_000_000);
    const block = BlockNumber.of(18000000);
    if (!requestId.ok || !deadline.ok || !block.ok) throw new Error("fixture context must parse");
    const ctx = { requestId: requestId.value, deadline: deadline.value, block: block.value };
    expect((await adapter.getBlockNumber(ctx)).ok).toBe(true);
    expect((await adapter.getBlockNumber(ctx)).ok).toBe(true);
    expect(chainCalls).toBe(1);
    expect(blockCalls).toBe(2);
    // Inside the interval no new chain call is made.
    now += 599_000;
    expect((await adapter.getBlockNumber(ctx)).ok).toBe(true);
    expect(chainCalls).toBe(1);
    // After the interval the endpoint is re-checked; a moved endpoint
    // fails closed with a typed error and sends no block call.
    chainResult = "0x5";
    now += 2_000;
    const blocked = await adapter.getBlockNumber(ctx);
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) {
      expect(blocked.error.kind).toBe("node-error");
      expect(blocked.error.message).toContain("not Ethereum mainnet");
      expect(blocked.error.message).not.toContain("rpc.example.invalid");
    }
    expect(chainCalls).toBe(2);
    expect(blockCalls).toBe(3);
  });

  test("k503_mainnet_chain_passes_verification", async () => {
    const checked = await verifyMainnetChainId(
      "https://example.invalid",
      cannedChainId("0x1"),
      1000,
    );
    expect(checked.ok).toBe(true);
  });
});
