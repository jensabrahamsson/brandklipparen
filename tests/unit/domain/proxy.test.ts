// Tests for P-13: legacy ZeppelinOS proxy slots and proxy facts.
import { describe, expect, test } from "vitest";
import {
  ADMIN_SLOT,
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
