import { describe, expect, test } from "vitest";
import { JsonRpcAdapter } from "../../../src/adapters/rpc/jsonRpcAdapter.ts";
import { SecretString } from "../../../src/ports/config.ts";
import { Address, BlockNumber, RequestId, Timestamp } from "../../../src/domain/types.ts";
import type { Result } from "../../../src/domain/result.ts";

function mustOk<T, E extends { message: string }>(result: Result<T, E>): T {
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

describe("RPC concurrency cap", () => {
  test("at most one transport is active when maxConcurrency is 1", async () => {
    let active = 0;
    let maxActive = 0;
    const releases: Array<() => void> = [];
    const adapter = new JsonRpcAdapter({
      endpoint: new SecretString("https://example.invalid/rpc"),
      timeoutMs: 5000,
      maxResponseBytes: 65536,
      maxConcurrency: 1,
      transport: async (_url, body) => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise<void>((resolve) => releases.push(resolve));
        active -= 1;
        const parsed = JSON.parse(body) as { id: number };
        return { status: 200, bodyText: JSON.stringify({ jsonrpc: "2.0", id: parsed.id, result: "0x10" }) };
      },
    });
    expect(adapter.limits().maxConcurrency).toBe(1);
    const ctx = {
      requestId: mustOk(RequestId.parse("123e4567-e89b-12d3-a456-426614174000")),
      deadline: mustOk(Timestamp.of(Date.now() + 5000)),
      block: mustOk(BlockNumber.of(16)),
    } as const;
    void mustOk(Address.parse(`0x5ab1e${"0".repeat(34)}1`));
    const first = adapter.getBlockNumber(ctx);
    const second = adapter.getBlockNumber(ctx);
    // Let both calls reach the adapter; only one may enter transport.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(maxActive).toBe(1);
    expect(releases).toHaveLength(1);
    releases[0]?.();
    await first;
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(releases).toHaveLength(2);
    releases[1]?.();
    await second;
    expect(maxActive).toBe(1);
  });
});
