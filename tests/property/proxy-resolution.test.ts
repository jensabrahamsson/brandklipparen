// Property test for S-006 (K-002, K-005): proxy resolution never throws
// and is deterministic. Written first per A-21 (red).
import { describe, expect, test } from "vitest";
import * as fc from "fast-check";
import { resolveProxy } from "../../src/application/resolveProxy.ts";
import type { Result } from "../../src/domain/result.ts";
import {
  Address,
  BlockNumber,
  RequestId,
  Timestamp,
} from "../../src/domain/types.ts";
import { FakeRpcAdapter } from "../fakes/fakeRpc.ts";
import type { BlockNumber as BlockNumberType } from "../../src/domain/types.ts";

function mustOk<T, E extends { message: string }>(result: Result<T, E>): T {
  if (!result.ok) {
    throw new Error(`expected ok, got error: ${result.error.message}`);
  }
  return result.value;
}

const ADDRESS_ARB = fc
  .array(fc.integer({ min: 0, max: 15 }), { minLength: 40, maxLength: 40 })
  .map((digits) => `0x${digits.map((digit) => (digit as number).toString(16)).join("")}`);

const WORD_ARB = fc
  .array(fc.integer({ min: 0, max: 15 }), { minLength: 64, maxLength: 64 })
  .map((digits) => `0x${digits.map((digit) => (digit as number).toString(16)).join("")}`);

const BYTECODE_ARB = fc
  .array(fc.integer({ min: 0, max: 255 }), { minLength: 0, maxLength: 96 })
  .map((bytes) => `0x${bytes.map((byte) => (byte as number).toString(16).padStart(2, "0")).join("")}`);

describe("proxy resolution properties (K-002, K-005)", () => {
  test("resolution_never_throws_and_is_deterministic", async () => {
    await fc.assert(
      fc.asyncProperty(
        ADDRESS_ARB,
        BYTECODE_ARB,
        WORD_ARB,
        WORD_ARB,
        fc.integer({ min: 1, max: 4 }),
        async (rawAddress, bytecodeHex, implWord, adminWord, maxDepth) => {
          const address = mustOk(Address.parse(rawAddress));
          const headBlock = mustOk(BlockNumber.of(24000000)) as BlockNumberType;
          const { IMPLEMENTATION_SLOT, ADMIN_SLOT } = await import(
            "../../src/domain/proxy.ts"
          );
          const codes = new Map<string, string>([[address as string, bytecodeHex]]);
          const storage = new Map<string, Map<string, string>>([
            [
              address as string,
              new Map<string, string>([
                [(IMPLEMENTATION_SLOT as string).toLowerCase(), implWord.toLowerCase()],
                [(ADMIN_SLOT as string).toLowerCase(), adminWord.toLowerCase()],
              ]),
            ],
          ]);
          const input = {
            address,
            block: headBlock,
            requestId: mustOk(RequestId.parse("123e4567-e89b-12d3-a456-426614174000")),
            deadline: mustOk(Timestamp.of(4102444800000)),
            maxDepth,
          } as const;
          const first = await resolveProxy({ rpc: new FakeRpcAdapter(codes, headBlock, storage) }, input);
          const second = await resolveProxy(
            { rpc: new FakeRpcAdapter(codes, headBlock, storage) },
            input,
          );
          expect(JSON.stringify(first)).toBe(JSON.stringify(second));
          if (first.ok && second.ok) {
            expect(JSON.stringify(first.value.resolution)).toBe(
              JSON.stringify(second.value.resolution),
            );
          }
        },
      ),
      { numRuns: 30 },
    );
  });
});
