// Proxy resolution failures must never fall back to scoring the shell.
import { describe, expect, test } from "vitest";
import { resolveAnalysisCode } from "../../../src/application/resolveAnalysisCode.ts";
import { err } from "../../../src/domain/result.ts";
import type { Result } from "../../../src/domain/result.ts";
import { Address, BlockNumber, RequestId, Timestamp } from "../../../src/domain/types.ts";
import { IMPLEMENTATION_SLOT } from "../../../src/domain/proxy.ts";
import { FakeRpcAdapter } from "../../fakes/fakeRpc.ts";
import type { BytecodeResult, CallContext, RpcError } from "../../../src/ports/rpc.ts";
import type { StorageWord as StorageWordType } from "../../../src/domain/types.ts";
import type { Address as AddressType, Slot as SlotType } from "../../../src/domain/types.ts";

function mustOk<T, E extends { message: string }>(result: Result<T, E>): T {
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}
const PROXY = `0x5ab1e${"0".repeat(34)}1`;
const IMPL = `0x5ab1e${"0".repeat(34)}2`;
const ADMIN = `0x5ab1e${"0".repeat(34)}3`;
function addressWord(raw: string): string {
  return `0x${"0".repeat(24)}${raw.slice(2).toLowerCase()}`;
}
const BLOCK = mustOk(BlockNumber.of(24000000));
const INPUT = {
  block: BLOCK,
  requestId: mustOk(RequestId.parse("123e4567-e89b-12d3-a456-426614174000")),
  deadline: mustOk(Timestamp.of(4102444800000)),
} as const;

function proxyRpc(codes: Map<string, string>): FakeRpcAdapter {
  const storage = new Map<string, Map<string, string>>([
    [
      mustOk(Address.parse(PROXY)) as string,
      new Map<string, string>([
        [(IMPLEMENTATION_SLOT as string).toLowerCase(), addressWord(IMPL).toLowerCase()],
      ]),
    ],
  ]);
  void ADMIN;
  return new FakeRpcAdapter(codes, BLOCK, storage);
}

describe("resolveAnalysisCode proxy failures", () => {
  test("implementation fetch failure is an error, not shell analysis", async () => {
    const proxy = mustOk(Address.parse(PROXY));
    const impl = mustOk(Address.parse(IMPL));
    class SecondFetchFailsRpc extends FakeRpcAdapter {
      private implCalls = 0;
      override async getCode(
        address: AddressType,
        ctx: CallContext,
      ): Promise<Result<BytecodeResult, RpcError>> {
        if ((address as string).toLowerCase() === (impl as string).toLowerCase()) {
          this.implCalls += 1;
          // First read (inside proxy resolution) succeeds; the
          // analysis-code read that follows fails upstream.
          if (this.implCalls > 1) {
            const failure: RpcError = { kind: "node-error", message: "impl read failed" };
            return err(failure);
          }
        }
        return super.getCode(address, ctx);
      }
    }
    const codes = new Map<string, string>([
      [proxy as string, "0x8063a9059cbb14600a575b6001600a600b600c600d600e600f55f4"],
      [impl as string, "0x6001600055"],
    ]);
    const base = proxyRpc(codes);
    void base;
    const storage = new Map<string, Map<string, string>>([
      [
        proxy as string,
        new Map<string, string>([[(IMPLEMENTATION_SLOT as string).toLowerCase(), addressWord(IMPL).toLowerCase()]]),
      ],
    ]);
    const rpc = new SecondFetchFailsRpc(codes, BLOCK, storage);
    const resolved = await resolveAnalysisCode({ rpc }, { address: proxy, ...INPUT });
    expect(resolved.ok).toBe(false);
    if (!resolved.ok) expect(resolved.error.kind).toBe("rpc-error");
  });

  test("proxy resolution failure is an error, not none", async () => {
    class FailingStorageRpc extends FakeRpcAdapter {
      override async getStorageAt(
        address: AddressType,
        slot: SlotType,
      ): Promise<Result<StorageWordType, RpcError>> {
        void address;
        void slot;
        return err({ kind: "node-error", message: "storage read failed" });
      }
    }
    const proxy = mustOk(Address.parse(PROXY));
    // A delegating (proxy-shaped) entry: its storage probe can forward,
    // so a storage failure must not fall back to scoring the shell.
    const codes = new Map<string, string>([
      [proxy as string, "0x8063a9059cbb14600a575b6001600a600b600c600d600e600f55f4"],
    ]);
    const storage = new Map<string, Map<string, string>>();
    const rpc = new FailingStorageRpc(codes, BLOCK, storage);
    const resolved = await resolveAnalysisCode({ rpc }, { address: proxy, ...INPUT });
    expect(resolved.ok).toBe(false);
    if (!resolved.ok) expect(resolved.error.kind).toBe("rpc-error");
  });

  test("storage failure for a non-delegating entry still scores the entry code", async () => {
    class FailingStorageRpc extends FakeRpcAdapter {
      override async getStorageAt(
        address: AddressType,
        slot: SlotType,
      ): Promise<Result<StorageWordType, RpcError>> {
        void address;
        void slot;
        return err({ kind: "node-error", message: "storage read failed" });
      }
    }
    const target = mustOk(Address.parse(PROXY));
    const codes = new Map<string, string>([[target as string, "0x6001600055"]]);
    const rpc = new FailingStorageRpc(codes, BLOCK, new Map());
    const resolved = await resolveAnalysisCode({ rpc }, { address: target, ...INPUT });
    expect(resolved.ok).toBe(true);
    if (resolved.ok) expect(resolved.value.proxy.kind).toBe("none");
  });

  test("bare delegatecall with empty proxy slots still scores the entry code", async () => {
    const target = mustOk(Address.parse(PROXY));
    const codes = new Map<string, string>([[target as string, "0x60006000f400"]]);
    const rpc = new FakeRpcAdapter(codes, BLOCK, new Map());
    const resolved = await resolveAnalysisCode({ rpc }, { address: target, ...INPUT });
    expect(resolved.ok).toBe(true);
    if (resolved.ok) expect(resolved.value.proxy.kind).toBe("none");
  });
});
