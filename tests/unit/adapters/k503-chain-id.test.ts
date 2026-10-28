// Mainnet chain verification at startup (S-108, K-001, K-503): the
// process verifies `eth_chainId` is `0x1` once before serving, and a
// transport answering any other chain fails typed so startup blocks.
// Written first (red) per A-21: no chain check exists. No network; the
// transports below answer canned chain ids.
import { describe, expect, test } from "vitest";
import { verifyMainnetChainId } from "../../../src/adapters/rpc/jsonRpcAdapter.ts";
import type { RpcTransport } from "../../../src/adapters/rpc/jsonRpcAdapter.ts";

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

  test("k503_mainnet_chain_passes_verification", async () => {
    const checked = await verifyMainnetChainId(
      "https://example.invalid",
      cannedChainId("0x1"),
      1000,
    );
    expect(checked.ok).toBe(true);
  });
});
