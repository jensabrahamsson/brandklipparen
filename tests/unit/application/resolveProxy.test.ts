// Unit tests for S-006 proxy resolution (K-002, K-005).
// Written first per A-21 (red): the domain proxy module, the application
// resolveProxy service and the storage-capable fake RPC do not exist yet.
// All addresses and bytecode are made-up synthetic values.
import { describe, expect, test } from "vitest";
import { resolveProxy } from "../../../src/application/resolveProxy.ts";
import type { Result } from "../../../src/domain/result.ts";
import {
  Address,
  BlockNumber,
  Bytecode,
  RequestId,
  Timestamp,
} from "../../../src/domain/types.ts";
import { FakeRpcAdapter } from "../../fakes/fakeRpc.ts";
import type { BlockNumber as BlockNumberType } from "../../../src/domain/types.ts";

const HEAD_BLOCK = 24000000;

function mustOk<T, E extends { message: string }>(result: Result<T, E>): T {
  if (!result.ok) {
    throw new Error(`expected ok, got error: ${result.error.message}`);
  }
  return result.value;
}

function headBlock(): BlockNumberType {
  return mustOk(BlockNumber.of(HEAD_BLOCK));
}

const PROXY = "0x0102030405060708090a0b0c0d0e0f1011121314";
const IMPL = "0x1112131415161718191a1b1c1d1e1f2021222324";
const ADMIN = "0x3132333435363738393a3b3c3d3e3f4041424344";
const OTHER = "0x5152535455565758595a5b5c5d5e5f6061626364";

const PROXY_BYTECODE = "0x6001600a600b600c600d600e600f55";
const IMPL_BYTECODE = "0x6001600055";
const ADMIN_BYTECODE = "0x6002600055";

function addressWord(raw: string): string {
  return `0x${"0".repeat(24)}${raw.slice(2).toLowerCase()}`;
}

const ZERO_WORD = `0x${"0".repeat(64)}`;
// Upper bytes set: an address field with garbage in the padding.
const GARBAGE_WORD = `0x${"ff".repeat(12)}${IMPL.slice(2).toLowerCase()}`;

function storageFor(entries: ReadonlyArray<readonly [string, string, string]>): Map<string, Map<string, string>> {
  const outer = new Map<string, Map<string, string>>();
  for (const [address, slot, word] of entries) {
    const checksummed = mustOk(Address.parse(address)) as string;
    let inner = outer.get(checksummed);
    if (inner === undefined) {
      inner = new Map<string, string>();
      outer.set(checksummed, inner);
    }
    inner.set(slot.toLowerCase(), word.toLowerCase());
  }
  return outer;
}

async function resolveWith(
  codes: ReadonlyMap<string, string>,
  storage: Map<string, Map<string, string>>,
  target: string,
  maxDepth?: number,
) {
  const rpc = new FakeRpcAdapter(codes, headBlock(), storage);
  return resolveProxy(
    { rpc },
    {
      address: mustOk(Address.parse(target)),
      block: headBlock(),
      requestId: mustOk(RequestId.parse("123e4567-e89b-12d3-a456-426614174000")),
      deadline: mustOk(Timestamp.of(4102444800000)),
      ...(maxDepth === undefined ? {} : { maxDepth }),
    },
  );
}

function codesFor(entries: ReadonlyArray<readonly [string, string]>): Map<string, string> {
  const codes = new Map<string, string>();
  for (const [address, code] of entries) {
    codes.set(mustOk(Address.parse(address)) as string, code);
  }
  return codes;
}

describe("proxy resolution through RpcPort (K-002, K-005)", () => {
  test("k002_empty_slot_means_no_eip1967_proxy", async () => {
    const { IMPLEMENTATION_SLOT } = await import("../../../src/domain/proxy.ts");
    const codes = codesFor([[PROXY, PROXY_BYTECODE]]);
    const storage = storageFor([[PROXY, IMPLEMENTATION_SLOT as string, ZERO_WORD]]);
    const result = await resolveWith(codes, storage, PROXY);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.value.resolution).toEqual({ kind: "none" });
  });

  test("non_proxy_bytecode_with_empty_slots_returns_no_proxy_info", async () => {
    const { IMPLEMENTATION_SLOT, ADMIN_SLOT } = await import("../../../src/domain/proxy.ts");
    const codes = codesFor([[OTHER, IMPL_BYTECODE]]);
    const storage = storageFor([
      [OTHER, IMPLEMENTATION_SLOT as string, ZERO_WORD],
      [OTHER, ADMIN_SLOT as string, ZERO_WORD],
    ]);
    const result = await resolveWith(codes, storage, OTHER);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.value.resolution.kind).toBe("none");
    expect(result.value.block as number).toBe(HEAD_BLOCK);
  });

  test("zero_and_garbage_slot_values_are_typed_outcomes_not_throws", async () => {
    const { IMPLEMENTATION_SLOT, decodeSlotAddress } = await import("../../../src/domain/proxy.ts");
    const { StorageWord } = await import("../../../src/domain/types.ts");
    const zero = decodeSlotAddress(mustOk(StorageWord.parse(ZERO_WORD)));
    expect(zero.kind).toBe("empty");
    const garbage = decodeSlotAddress(mustOk(StorageWord.parse(GARBAGE_WORD)));
    expect(garbage.kind).toBe("garbage");
    const codes = codesFor([[PROXY, PROXY_BYTECODE]]);
    const storage = storageFor([[PROXY, IMPLEMENTATION_SLOT as string, GARBAGE_WORD]]);
    const result = await resolveWith(codes, storage, PROXY);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.value.resolution.kind).toBe("none");
  });

  test("k002_admin_classified_as_eoa_contract_or_zero", async () => {
    const { IMPLEMENTATION_SLOT, ADMIN_SLOT } = await import("../../../src/domain/proxy.ts");
    const implWord = addressWord(IMPL);
    // EOA admin: no code at the admin address.
    const eoaCodes = codesFor([
      [PROXY, PROXY_BYTECODE],
      [IMPL, IMPL_BYTECODE],
    ]);
    const eoaStorage = storageFor([
      [PROXY, IMPLEMENTATION_SLOT as string, implWord],
      [PROXY, ADMIN_SLOT as string, addressWord(ADMIN)],
    ]);
    const eoa = await resolveWith(eoaCodes, eoaStorage, PROXY);
    expect(eoa.ok).toBe(true);
    if (!eoa.ok || eoa.value.resolution.kind !== "eip1967") {
      throw new Error("expected an eip1967 resolution for the eoa admin case");
    }
    expect(eoa.value.resolution.admin.kind).toBe("eoa");
    // Contract admin: code at the admin address.
    const contractCodes = codesFor([
      [PROXY, PROXY_BYTECODE],
      [IMPL, IMPL_BYTECODE],
      [ADMIN, ADMIN_BYTECODE],
    ]);
    const contract = await resolveWith(contractCodes, eoaStorage, PROXY);
    expect(contract.ok).toBe(true);
    if (!contract.ok || contract.value.resolution.kind !== "eip1967") {
      throw new Error("expected an eip1967 resolution for the contract admin case");
    }
    expect(contract.value.resolution.admin.kind).toBe("contract");
    // Zero admin.
    const zeroStorage = storageFor([
      [PROXY, IMPLEMENTATION_SLOT as string, implWord],
      [PROXY, ADMIN_SLOT as string, ZERO_WORD],
    ]);
    const zero = await resolveWith(eoaCodes, zeroStorage, PROXY);
    expect(zero.ok).toBe(true);
    if (!zero.ok || zero.value.resolution.kind !== "eip1967") {
      throw new Error("expected an eip1967 resolution for the zero admin case");
    }
    expect(zero.value.resolution.admin.kind).toBe("zero");
  });

  test("k002_reports_who_can_upgrade", async () => {
    const { IMPLEMENTATION_SLOT, ADMIN_SLOT } = await import("../../../src/domain/proxy.ts");
    const codes = codesFor([
      [PROXY, PROXY_BYTECODE],
      [IMPL, IMPL_BYTECODE],
    ]);
    const storage = storageFor([
      [PROXY, IMPLEMENTATION_SLOT as string, addressWord(IMPL)],
      [PROXY, ADMIN_SLOT as string, addressWord(ADMIN)],
    ]);
    const result = await resolveWith(codes, storage, PROXY);
    expect(result.ok).toBe(true);
    if (!result.ok || result.value.resolution.kind !== "eip1967") {
      throw new Error("expected an eip1967 resolution");
    }
    const authority = result.value.resolution.upgradeAuthority;
    expect(authority.kind).toBe("single-key");
    if (authority.kind !== "single-key") {
      return;
    }
    expect(authority.holder as string).toBe(mustOk(Address.parse(ADMIN)) as string);
  });

  test("k005_reports_upgrade_function_and_caller", async () => {
    const { proxiableUUIDSelector } = await import("../../../src/domain/proxy.ts");
    const selector = proxiableUUIDSelector();
    const bytecode = `0x8063${(selector as string).slice(2)}14600a57${"00".repeat(16)}`;
    void Bytecode.parse(bytecode);
    const { IMPLEMENTATION_SLOT, ADMIN_SLOT } = await import("../../../src/domain/proxy.ts");
    const codes = codesFor([
      [PROXY, bytecode],
      [IMPL, bytecode],
    ]);
    const storage = storageFor([
      [PROXY, IMPLEMENTATION_SLOT as string, addressWord(IMPL)],
      [PROXY, ADMIN_SLOT as string, addressWord(ADMIN)],
    ]);
    const result = await resolveWith(codes, storage, PROXY);
    expect(result.ok).toBe(true);
    if (!result.ok || result.value.resolution.kind !== "uups") {
      throw new Error(`expected a uups resolution, got ${result.ok ? result.value.resolution.kind : "error"}`);
    }
    expect(result.value.resolution.upgradeFunction as string).toBe(selector as string);
    const authority = result.value.resolution.upgradeAuthority;
    expect(authority.kind).toBe("single-key");
  });

  test("k005_locked_upgrade_marked_as_locked", async () => {
    const { proxiableUUIDSelector, IMPLEMENTATION_SLOT, ADMIN_SLOT } = await import(
      "../../../src/domain/proxy.ts"
    );
    const selector = proxiableUUIDSelector();
    const bytecode = `0x8063${(selector as string).slice(2)}14600a57${"00".repeat(16)}`;
    const codes = codesFor([
      [PROXY, bytecode],
      [IMPL, bytecode],
    ]);
    const storage = storageFor([
      [PROXY, IMPLEMENTATION_SLOT as string, addressWord(IMPL)],
      [PROXY, ADMIN_SLOT as string, ZERO_WORD],
    ]);
    const result = await resolveWith(codes, storage, PROXY);
    expect(result.ok).toBe(true);
    if (!result.ok || result.value.resolution.kind !== "uups") {
      throw new Error("expected a uups resolution");
    }
    expect(result.value.resolution.upgradeAuthority).toEqual({ kind: "locked" });
  });

  test("proxy_cycles_terminate", async () => {
    const { IMPLEMENTATION_SLOT, ADMIN_SLOT } = await import("../../../src/domain/proxy.ts");
    const codes = codesFor([
      [PROXY, PROXY_BYTECODE],
      [IMPL, PROXY_BYTECODE],
    ]);
    const storage = storageFor([
      [PROXY, IMPLEMENTATION_SLOT as string, addressWord(IMPL)],
      [PROXY, ADMIN_SLOT as string, ZERO_WORD],
      [IMPL, IMPLEMENTATION_SLOT as string, addressWord(PROXY)],
      [IMPL, ADMIN_SLOT as string, ZERO_WORD],
    ]);
    const result = await resolveWith(codes, storage, PROXY, 10);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(["eip1967", "uups"]).toContain(result.value.resolution.kind);
  });

  test("zos_slot_word_resolves_as_zos_with_implementation", async () => {
    const { ZOS_IMPLEMENTATION_SLOT, ZOS_ADMIN_SLOT } = await import("../../../src/domain/proxy.ts");
    const codes = codesFor([
      [PROXY, PROXY_BYTECODE],
      [IMPL, IMPL_BYTECODE],
      [ADMIN, ADMIN_BYTECODE],
    ]);
    const storage = storageFor([
      [PROXY, ZOS_IMPLEMENTATION_SLOT as string, addressWord(IMPL)],
      [PROXY, ZOS_ADMIN_SLOT as string, addressWord(ADMIN)],
    ]);
    const result = await resolveWith(codes, storage, PROXY);
    expect(result.ok).toBe(true);
    if (!result.ok || result.value.resolution.kind !== "zos") {
      throw new Error(`expected a zos resolution, got ${result.ok ? result.value.resolution.kind : "error"}`);
    }
    expect(result.value.resolution.implementation as string).toBe(mustOk(Address.parse(IMPL)) as string);
    expect(result.value.resolution.admin.kind).toBe("contract");
    expect(result.value.resolution.implementationSlot as string).toBe(ZOS_IMPLEMENTATION_SLOT as string);
  });

  test("f1_implementation_own_slot_pointing_elsewhere_is_ignored", async () => {
    const { IMPLEMENTATION_SLOT, ADMIN_SLOT } = await import("../../../src/domain/proxy.ts");
    const codes = codesFor([
      [PROXY, PROXY_BYTECODE],
      [IMPL, IMPL_BYTECODE],
      [OTHER, ADMIN_BYTECODE],
    ]);
    const storage = storageFor([
      [PROXY, IMPLEMENTATION_SLOT as string, addressWord(IMPL)],
      [PROXY, ADMIN_SLOT as string, ZERO_WORD],
      // Attacker-controlled storage behind the implementation: a clean
      // contract address written into the implementation's own slot must
      // never steer the reported implementation.
      [IMPL, IMPLEMENTATION_SLOT as string, addressWord(OTHER)],
      [IMPL, ADMIN_SLOT as string, addressWord(ADMIN)],
    ]);
    const rpc = new FakeRpcAdapter(codes, headBlock(), storage);
    const result = await resolveProxy(
      { rpc },
      {
        address: mustOk(Address.parse(PROXY)),
        block: headBlock(),
        requestId: mustOk(RequestId.parse("123e4567-e89b-12d3-a456-426614174000")),
        deadline: mustOk(Timestamp.of(4102444800000)),
      },
    );
    expect(result.ok).toBe(true);
    if (!result.ok || result.value.resolution.kind !== "eip1967") {
      throw new Error("expected an eip1967 resolution");
    }
    expect(result.value.resolution.implementation as string).toBe(
      mustOk(Address.parse(IMPL)) as string,
    );
    for (const call of rpc.getStorageAtCalls) {
      expect(call.address).toBe(mustOk(Address.parse(PROXY)) as string);
    }
  });

  test("f1_eip1967_to_1167_chain_keeps_outer_admin", async () => {
    const { IMPLEMENTATION_SLOT, ADMIN_SLOT } = await import("../../../src/domain/proxy.ts");
    const stub = `0x363d3d373d3d3d363d73${OTHER.slice(2).toLowerCase()}5af43d82803e903d91602b57fd5bf3`;
    const codes = codesFor([
      [PROXY, PROXY_BYTECODE],
      [IMPL, stub],
      [OTHER, IMPL_BYTECODE],
    ]);
    const storage = storageFor([
      [PROXY, IMPLEMENTATION_SLOT as string, addressWord(IMPL)],
      [PROXY, ADMIN_SLOT as string, addressWord(ADMIN)],
    ]);
    const rpc = new FakeRpcAdapter(codes, headBlock(), storage);
    const result = await resolveProxy(
      { rpc },
      {
        address: mustOk(Address.parse(PROXY)),
        block: headBlock(),
        requestId: mustOk(RequestId.parse("123e4567-e89b-12d3-a456-426614174000")),
        deadline: mustOk(Timestamp.of(4102444800000)),
      },
    );
    expect(result.ok).toBe(true);
    if (!result.ok || result.value.resolution.kind !== "eip1967") {
      throw new Error("expected an eip1967 resolution");
    }
    expect(result.value.resolution.implementation as string).toBe(
      mustOk(Address.parse(OTHER)) as string,
    );
    expect(result.value.resolution.admin.kind).toBe("eoa");
    if (result.value.resolution.admin.kind !== "eoa") {
      return;
    }
    expect(result.value.resolution.admin.address as string).toBe(
      mustOk(Address.parse(ADMIN)) as string,
    );
    for (const call of rpc.getStorageAtCalls) {
      expect(call.address).toBe(mustOk(Address.parse(PROXY)) as string);
    }
  });

  test("proxy_depth_limit_terminates", async () => {
    const { IMPLEMENTATION_SLOT, ADMIN_SLOT } = await import("../../../src/domain/proxy.ts");
    const addrs = [PROXY, IMPL, ADMIN, OTHER];
    const codes = codesFor(addrs.map((address) => [address, PROXY_BYTECODE] as const));
    const entries: Array<readonly [string, string, string]> = [];
    for (let index = 0; index < addrs.length; index += 1) {
      const current = addrs[index] ?? PROXY;
      const next = addrs[(index + 1) % addrs.length] ?? IMPL;
      entries.push([current, IMPLEMENTATION_SLOT as string, addressWord(next)]);
      entries.push([current, ADMIN_SLOT as string, ZERO_WORD]);
    }
    const result = await resolveWith(codes, storageFor(entries), PROXY, 2);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(["eip1967", "uups", "none"]).toContain(result.value.resolution.kind);
  });
});
