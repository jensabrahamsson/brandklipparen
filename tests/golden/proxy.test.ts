// Golden proxy tests for S-006 (K-002, K-005).
// Written first per A-21 (red): the domain proxy module and the application
// resolveProxy service do not exist yet, so these tests fail until the
// implementation lands. Recorded synthetic transports replay frozen
// responses; no network access happens. All addresses are made-up
// synthetic values, never real contracts.
import { describe, expect, test } from "vitest";
import { JsonRpcAdapter } from "../../src/adapters/rpc/jsonRpcAdapter.ts";
import type { RpcTransport } from "../../src/adapters/rpc/jsonRpcAdapter.ts";
import { resolveProxy } from "../../src/application/resolveProxy.ts";
import { CodeHash } from "../../src/domain/types.ts";
import { keccak256HexOfUtf8 } from "../../src/domain/types.ts";
import {
  ADMIN_SLOT,
  IMPLEMENTATION_SLOT,
  PROXIABLE_UUID_SIGNATURE,
  bytecodeHasSelector,
  proxiableUUIDSelector,
  slotForLabel,
} from "../../src/domain/proxy.ts";
import type { Result } from "../../src/domain/result.ts";
import {
  Address,
  BlockNumber,
  Bytecode,
  RequestId,
  Timestamp,
} from "../../src/domain/types.ts";
import { SecretString } from "../../src/ports/config.ts";
import type { CallContext } from "../../src/ports/rpc.ts";

const PINNED_BLOCK = 24000000;
const PINNED_BLOCK_HEX = "0x16e3600";

const PROXY_ADDRESS = "0x0102030405060708090a0b0c0d0e0f1011121314";
const IMPL_ADDRESS = "0x1112131415161718191a1b1c1d1e1f2021222324";
const ADMIN_EOA = "0x3132333435363738393a3b3c3d3e3f4041424344";

// Route keys carry the checksummed form, matching the addresses the
// adapter sends on the wire after Address.parse at the boundary.
function onWire(raw: string): string {
  const parsed = Address.parse(raw);
  if (!parsed.ok) {
    throw new Error(`bad test address: ${raw}`);
  }
  return parsed.value as string;
}

const PROXY_WIRE = onWire(PROXY_ADDRESS);
const IMPL_WIRE = onWire(IMPL_ADDRESS);
const ADMIN_WIRE = onWire(ADMIN_EOA);

const PROXY_BYTECODE = "0x6001600a600b600c600d600e600f55";
const IMPL_BYTECODE = "0x6001600055";

function mustOk<T, E extends { message: string }>(result: Result<T, E>): T {
  if (!result.ok) {
    throw new Error(`expected ok, got error: ${result.error.message}`);
  }
  return result.value;
}

function fixedContext(): CallContext {
  return {
    requestId: mustOk(RequestId.parse("123e4567-e89b-12d3-a456-426614174000")),
    deadline: mustOk(Timestamp.of(4102444800000)),
    block: mustOk(BlockNumber.of(PINNED_BLOCK)),
  };
}

function addressWord(raw: string): string {
  return `0x${"0".repeat(24)}${raw.slice(2).toLowerCase()}`;
}

// Recorded synthetic transport: routes on method plus params, so the two
// storage slots and the per-address code reads each replay their frozen
// response with zero network calls.
function makeRecordedTransport(routes: ReadonlyMap<string, string>): {
  transport: RpcTransport;
  calls: string[];
} {
  const calls: string[] = [];
  const transport: RpcTransport = async (_url, body) => {
    const request = JSON.parse(body) as { id: unknown; method: string; params: unknown };
    const key = `${request.method}:${JSON.stringify(request.params)}`;
    calls.push(key);
    const result = routes.get(key);
    if (result === undefined) {
      throw new Error(`unexpected JSON-RPC call: ${key}`);
    }
    return { status: 200, bodyText: JSON.stringify({ jsonrpc: "2.0", id: request.id, result }) };
  };
  return { transport, calls };
}

function proxyRoutes(overrides: {
  proxyBytecode: string;
  implWord: string;
  adminWord: string;
  implBytecode: string;
  adminCode: string;
}): ReadonlyMap<string, string> {
  const block = PINNED_BLOCK_HEX;
  const zeroWord = `0x${"0".repeat(64)}`;
  return new Map<string, string>([
    [`eth_getCode:${JSON.stringify([PROXY_WIRE, block])}`, overrides.proxyBytecode],
    [
      `eth_getStorageAt:${JSON.stringify([PROXY_WIRE, IMPLEMENTATION_SLOT as string, block])}`,
      overrides.implWord,
    ],
    [
      `eth_getStorageAt:${JSON.stringify([PROXY_WIRE, ADMIN_SLOT as string, block])}`,
      overrides.adminWord,
    ],
    [`eth_getCode:${JSON.stringify([IMPL_WIRE, block])}`, overrides.implBytecode],
    [`eth_getCode:${JSON.stringify([ADMIN_WIRE, block])}`, overrides.adminCode],
    // Chain following reads the implementation's own slots to terminate the
    // walk: a non-chained implementation reports empty slots.
    [
      `eth_getStorageAt:${JSON.stringify([IMPL_WIRE, IMPLEMENTATION_SLOT as string, block])}`,
      zeroWord,
    ],
    [
      `eth_getStorageAt:${JSON.stringify([IMPL_WIRE, ADMIN_SLOT as string, block])}`,
      zeroWord,
    ],
  ]);
}

describe("proxy resolution golden paths (K-002, K-005)", () => {
  test("k002_eip1967_slots_follow_the_spec_formula", () => {
    // The slot definitions are computed from the public spec formula with
    // the existing Keccak implementation, never copied from elsewhere.
    const minusOne = (hex: string): string => {
      const value = BigInt(hex) - 1n;
      return `0x${value.toString(16).padStart(64, "0")}`;
    };
    expect(IMPLEMENTATION_SLOT as string).toBe(
      minusOne(keccak256HexOfUtf8("eip1967.proxy.implementation")),
    );
    expect(ADMIN_SLOT as string).toBe(minusOne(keccak256HexOfUtf8("eip1967.proxy.admin")));
    expect(slotForLabel("eip1967.proxy.implementation") as string).toBe(
      IMPLEMENTATION_SLOT as string,
    );
    expect(PROXIABLE_UUID_SIGNATURE).toBe("proxiableUUID()");
  });

  test("k002_eip1967_returns_proxy_and_implementation", async () => {
    const routes = proxyRoutes({
      proxyBytecode: PROXY_BYTECODE,
      implWord: addressWord(IMPL_ADDRESS),
      adminWord: addressWord(ADMIN_EOA),
      implBytecode: IMPL_BYTECODE,
      adminCode: "0x",
    });
    const { transport, calls } = makeRecordedTransport(routes);
    const rpc = new JsonRpcAdapter({
      endpoint: new SecretString("https://recorded.invalid/synthetic"),
      timeoutMs: 1000,
      maxResponseBytes: 65536,
      transport,
    });
    const result = await resolveProxy(
      { rpc },
      {
        address: mustOk(Address.parse(PROXY_ADDRESS)),
        block: mustOk(BlockNumber.of(PINNED_BLOCK)),
        requestId: mustOk(RequestId.parse("123e4567-e89b-12d3-a456-426614174000")),
        deadline: mustOk(Timestamp.of(4102444800000)),
      },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.value.block as number).toBe(PINNED_BLOCK);
    const resolution = result.value.resolution;
    expect(resolution.kind).toBe("eip1967");
    if (resolution.kind !== "eip1967") {
      return;
    }
    expect(resolution.implementation as string).toBe(mustOk(Address.parse(IMPL_ADDRESS)) as string);
    const expectedHash = mustOk(CodeHash.of(mustOk(Bytecode.parse(IMPL_BYTECODE))));
    expect(resolution.implementationCodeHash as string).toBe(expectedHash as string);
    expect(resolution.implementationSlot as string).toBe(IMPLEMENTATION_SLOT as string);
    expect(resolution.adminSlot as string).toBe(ADMIN_SLOT as string);
    expect(resolution.block as number).toBe(PINNED_BLOCK);
    expect(resolution.admin.kind).toBe("eoa");
    if (resolution.admin.kind !== "eoa") {
      return;
    }
    expect(resolution.admin.address as string).toBe(mustOk(Address.parse(ADMIN_EOA)) as string);
    expect(resolution.upgradeAuthority.kind).toBe("single-key");
    // Every read is pinned to the frozen block: no latest lookups.
    for (const key of calls) {
      if (key.includes("eth_getCode") || key.includes("eth_getStorageAt")) {
        expect(key).toContain(PINNED_BLOCK_HEX);
      }
    }
  });

  test("k005_uups_returns_implementation", async () => {
    const selector = proxiableUUIDSelector();
    const proxyBytecode = `0x8063${(selector as string).slice(2)}14600a57${"00".repeat(16)}`;
    expect(bytecodeHasSelector(mustOk(Bytecode.parse(proxyBytecode)), selector)).toBe(true);
    const routes = proxyRoutes({
      proxyBytecode,
      implWord: addressWord(IMPL_ADDRESS),
      adminWord: `0x${"0".repeat(64)}`,
      implBytecode: proxyBytecode,
      adminCode: "0x",
    });
    const { transport } = makeRecordedTransport(routes);
    const rpc = new JsonRpcAdapter({
      endpoint: new SecretString("https://recorded.invalid/synthetic"),
      timeoutMs: 1000,
      maxResponseBytes: 65536,
      transport,
    });
    const result = await resolveProxy(
      { rpc },
      {
        address: mustOk(Address.parse(PROXY_ADDRESS)),
        block: mustOk(BlockNumber.of(PINNED_BLOCK)),
        requestId: mustOk(RequestId.parse("123e4567-e89b-12d3-a456-426614174000")),
        deadline: mustOk(Timestamp.of(4102444800000)),
      },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    const resolution = result.value.resolution;
    expect(resolution.kind).toBe("uups");
    if (resolution.kind !== "uups") {
      return;
    }
    expect(resolution.implementation as string).toBe(mustOk(Address.parse(IMPL_ADDRESS)) as string);
    const expectedHash = mustOk(CodeHash.of(mustOk(Bytecode.parse(proxyBytecode))));
    expect(resolution.implementationCodeHash as string).toBe(expectedHash as string);
    expect(resolution.upgradeFunction as string).toBe(selector as string);
    expect(resolution.upgradeAuthority.kind).toBe("locked");
    expect(resolution.block as number).toBe(PINNED_BLOCK);
  });

  test("k002_storage_reads_use_the_pinned_block_context", async () => {
    const routes = proxyRoutes({
      proxyBytecode: PROXY_BYTECODE,
      implWord: addressWord(IMPL_ADDRESS),
      adminWord: addressWord(ADMIN_EOA),
      implBytecode: IMPL_BYTECODE,
      adminCode: "0x",
    });
    const { transport, calls } = makeRecordedTransport(routes);
    const rpc = new JsonRpcAdapter({
      endpoint: new SecretString("https://recorded.invalid/synthetic"),
      timeoutMs: 1000,
      maxResponseBytes: 65536,
      transport,
    });
    await resolveProxy(
      { rpc },
      {
        address: mustOk(Address.parse(PROXY_ADDRESS)),
        block: mustOk(BlockNumber.of(PINNED_BLOCK)),
        requestId: fixedContext().requestId,
        deadline: fixedContext().deadline,
      },
    );
    const storageCalls = calls.filter((key) => key.startsWith("eth_getStorageAt"));
    expect(storageCalls.length).toBeGreaterThan(0);
    for (const key of storageCalls) {
      expect(key).toContain(PINNED_BLOCK_HEX);
    }
  });
});
