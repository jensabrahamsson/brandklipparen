// Tests for P-13: legacy ZeppelinOS proxy slots and proxy facts.
import { describe, expect, test } from "vitest";
import {
  ADMIN_SLOT,
  BEACON_SLOT,
  IMPLEMENTATION_SLOT,
  ZOS_ADMIN_LABEL,
  ZOS_ADMIN_SLOT,
  ZOS_IMPLEMENTATION_LABEL,
  ZOS_IMPLEMENTATION_SLOT,
  proxyFactOf,
  proxyToCanonical,
  slotForLabel,
  slotForLabelRaw,
} from "../../../src/domain/proxy.ts";
import { Address, BlockNumber, Bytecode, CodeHash, keccak256HexOfUtf8 } from "../../../src/domain/types.ts";
import type { Result } from "../../../src/domain/result.ts";

function mustOk<T, E extends { message: string }>(result: Result<T, E>): T {
  if (!result.ok) {
    throw new Error(`expected ok, got error: ${result.error.message}`);
  }
  return result.value;
}

const IMPL = "0x1112131415161718191a1b1c1d1e1f2021222324";
const ADMIN = "0x3132333435363738393a3b3c3d3e3f4041424344";

describe("legacy ZeppelinOS slots (P-13)", () => {
  test("zos slots derive as keccak256(label) with no minus-one", () => {
    expect(ZOS_IMPLEMENTATION_SLOT as string).toBe(keccak256HexOfUtf8(ZOS_IMPLEMENTATION_LABEL));
    expect(ZOS_ADMIN_SLOT as string).toBe(keccak256HexOfUtf8(ZOS_ADMIN_LABEL));
    expect(slotForLabelRaw(ZOS_IMPLEMENTATION_LABEL) as string).toBe(ZOS_IMPLEMENTATION_SLOT as string);
    // EIP-1967 slots remain keccak minus one and differ from raw.
    expect(IMPLEMENTATION_SLOT as string).not.toBe(slotForLabelRaw("eip1967.proxy.implementation"));
    expect(slotForLabel("eip1967.proxy.implementation") as string).toBe(IMPLEMENTATION_SLOT as string);
    expect(ZOS_IMPLEMENTATION_SLOT as string).not.toBe(IMPLEMENTATION_SLOT as string);
    expect(ZOS_ADMIN_SLOT as string).not.toBe(ADMIN_SLOT as string);
  });

  test("proxyFactOf maps a zos resolution and canonical keeps kind zos", () => {
    const impl = mustOk(Address.parse(IMPL));
    const admin = mustOk(Address.parse(ADMIN));
    const hash = mustOk(CodeHash.of(mustOk(Bytecode.parse("0x6001600055"))));
    const resolution = Object.freeze({
      kind: "zos" as const,
      implementation: impl,
      implementationCodeHash: hash,
      implementationSlot: ZOS_IMPLEMENTATION_SLOT,
      adminSlot: ZOS_ADMIN_SLOT,
      block: mustOk(BlockNumber.of(24000000)),
      admin: Object.freeze({ kind: "contract" as const, address: admin, codeHash: hash }),
      upgradeAuthority: Object.freeze({ kind: "contract" as const, holder: admin, codeHash: hash }),
    });
    const fact = proxyFactOf(resolution);
    expect(fact?.proxyKind).toBe("zos");
    expect(fact?.implementation as string).toBe(impl as string);
    expect(fact?.admin as string).toBe(admin as string);
    expect(fact?.adminKind).toBe("contract");
    const canonical = proxyToCanonical(resolution) as Record<string, unknown>;
    expect(canonical["kind"]).toBe("zos");
    expect(canonical["implementation"]).toBe(impl as string);
  });

  test("proxyFactOf returns null for none", () => {
    expect(proxyFactOf(Object.freeze({ kind: "none" as const }))).toBeNull();
  });
});

describe("C-11 clone templates and beacon mappings", () => {
  const TARGET = "0x3a3b3c3d3e3f4041424344454647484950515253";
  const BEACON_ADDR = "0x7172737475767778797a7b7c7d7e7f8081828384";

  test("c11_parse_accepts_solady_push0_clone", async () => {
    const { parseEip1167Target } = await import("../../../src/domain/proxy.ts");
    const code = `0x5f5f365f5f37365f73${TARGET.slice(2).toLowerCase()}5af43d5f5f3e6029573d5ffd5b3d5ff3`;
    const bytes = Buffer.from(code.slice(2), "hex");
    expect(bytes.length).toBe(45);
    // The PUSH1 0x29 operand at index 36 targets the 0x5b at index 41.
    expect(bytes[36]).toBe(0x29);
    expect(bytes[41]).toBe(0x5b);
    expect(parseEip1167Target(mustOk(Bytecode.parse(code))) as string).toBe(
      mustOk(Address.parse(TARGET)) as string,
    );
  });

  test("c11_parse_accepts_clone_with_trailing_immutable_args", async () => {
    const { parseEip1167Target } = await import("../../../src/domain/proxy.ts");
    const stub = `0x363d3d373d3d3d363d73${TARGET.slice(2).toLowerCase()}5af43d82803e903d91602b57fd5bf3`;
    const code = `${stub}${"cd".repeat(64)}`;
    expect(parseEip1167Target(mustOk(Bytecode.parse(code))) as string).toBe(
      mustOk(Address.parse(TARGET)) as string,
    );
  });

  test("c11_beacon_canonical_carries_implementation_authority", async () => {
    const impl = mustOk(Address.parse(TARGET));
    const beacon = mustOk(Address.parse(BEACON_ADDR));
    const hash = mustOk(CodeHash.of(mustOk(Bytecode.parse("0x6001600055"))));
    const resolution = Object.freeze({
      kind: "beacon" as const,
      beacon,
      beaconCodeHash: hash,
      implementation: impl,
      implementationCodeHash: hash,
      beaconSlot: BEACON_SLOT,
      block: mustOk(BlockNumber.of(24000000)),
      upgradeAuthority: Object.freeze({ kind: "implementation" as const }),
    });
    const canonical = proxyToCanonical(resolution) as Record<string, unknown>;
    expect(canonical["kind"]).toBe("beacon");
    expect(canonical["implementation"]).toBe(impl as string);
    expect(canonical["upgradeAuthority"]).toEqual({ kind: "implementation" });
    const fact = proxyFactOf(resolution);
    expect(fact?.proxyKind).toBe("beacon");
    expect(fact?.admin).toBeNull();
    expect(fact?.adminKind).toBe("none");
  });

  test("c11_garbage_admin_fact_names_no_holder", () => {
    const impl = mustOk(Address.parse(TARGET));
    const hash = mustOk(CodeHash.of(mustOk(Bytecode.parse("0x6001600055"))));
    const resolution = Object.freeze({
      kind: "eip1967" as const,
      implementation: impl,
      implementationCodeHash: hash,
      implementationSlot: IMPLEMENTATION_SLOT,
      adminSlot: ADMIN_SLOT,
      block: mustOk(BlockNumber.of(24000000)),
      admin: Object.freeze({ kind: "unknown" as const }),
      upgradeAuthority: Object.freeze({ kind: "unknown" as const }),
    });
    const fact = proxyFactOf(resolution);
    expect(fact?.admin).toBeNull();
    expect(fact?.adminKind).toBe("none");
    const canonical = proxyToCanonical(resolution) as Record<string, unknown>;
    expect(canonical["upgradeAuthority"]).toEqual({ kind: "unknown" });
  });
});
