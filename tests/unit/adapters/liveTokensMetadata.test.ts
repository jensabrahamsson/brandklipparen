// Token metadata reader (E-11 follow-up): name()/symbol() over a stub
// RpcPort, decoding ABI strings and bytes32 values. Written first
// (red) per A-21: the reader does not exist yet.
import { describe, expect, test } from "vitest";
import { err, ok } from "../../../src/domain/result.ts";
import type { Result } from "../../../src/domain/result.ts";
import { CallData, keccak256HexOfUtf8 } from "../../../src/domain/types.ts";
import type {
  Address as AddressType,
  CallData as CallDataType,
} from "../../../src/domain/types.ts";
import type { RpcError, RpcPort } from "../../../src/ports/rpc.ts";
import { createTokenMetadataReader } from "../../../src/adapters/liveTokens/tokenMetadata.ts";
import { syntheticAddress } from "../../helpers/syntheticAddresses.ts";

const TOKEN = syntheticAddress(2);

function bytesToHex(bytes: Uint8Array): string {
  return `0x${[...bytes].map((entry) => entry.toString(16).padStart(2, "0")).join("")}`;
}

function abiString(text: string): Uint8Array {
  const payload = new TextEncoder().encode(text);
  const chunks = Math.max(1, Math.ceil(payload.length / 32));
  const out = new Uint8Array(64 + chunks * 32);
  const view = new DataView(out.buffer);
  view.setBigUint64(24, 32n);
  view.setBigUint64(56, BigInt(payload.length));
  out.set(payload, 64);
  return out;
}

function bytes32(text: string): Uint8Array {
  const payload = new TextEncoder().encode(text);
  const out = new Uint8Array(32);
  out.set(payload.slice(0, 32));
  return out;
}

function stubRpc(answers: ReadonlyMap<string, Uint8Array | null>): RpcPort {
  const unsupported = (): Promise<never> => Promise.reject(new Error("unsupported in this test"));
  return {
    getCode: () => unsupported(),
    getStorageAt: () => unsupported(),
    getBlockNumber: () => unsupported(),
    getLogs: () => unsupported(),
    getBlockReceipts: () => unsupported(),
    call: async (_to: AddressType, data: CallDataType): Promise<Result<CallDataType, RpcError>> => {
      const hex = bytesToHex(data).toLowerCase();
      const answer = answers.get(hex) ?? null;
      if (answer === null) {
        return err({ kind: "timeout", message: "no answer" });
      }
      const parsed = CallData.parse(bytesToHex(answer));
      if (!parsed.ok) {
        return err({ kind: "invalid-response", message: "bad fixture" });
      }
      return ok(parsed.value);
    },
  } as RpcPort;
}

describe("token metadata reader", () => {
  test("reads ABI string symbol and name", async () => {
    const rpc = stubRpc(
      new Map([
        ["0x95d89b41", abiString("TKN")],
        ["0x06fdde03", abiString("Token")],
      ]),
    );
    const read = createTokenMetadataReader(rpc);
    expect(await read(TOKEN)).toEqual({ symbol: "TKN", name: "Token" });
  });

  test("reads compact bytes32 values", async () => {
    const rpc = stubRpc(
      new Map([
        ["0x95d89b41", bytes32("TKN")],
        ["0x06fdde03", bytes32("Token")],
      ]),
    );
    const read = createTokenMetadataReader(rpc);
    expect(await read(TOKEN)).toEqual({ symbol: "TKN", name: "Token" });
  });

  test("answers null when the token has no metadata", async () => {
    const rpc = stubRpc(new Map());
    const read = createTokenMetadataReader(rpc);
    expect(await read(TOKEN)).toBeNull();
    expect(await read("not-an-address")).toBeNull();
  });

  test("keeps partial metadata when one call fails", async () => {
    const rpc = stubRpc(new Map([["0x95d89b41", abiString("TKN")]]));
    const read = createTokenMetadataReader(rpc);
    expect(await read(TOKEN)).toEqual({ symbol: "TKN", name: null });
  });

  test("requests the on-chain symbol() and name() selectors", async () => {
    const seen: string[] = [];
    const rpc = stubRpc(new Map());
    const capturing: RpcPort = {
      ...rpc,
      call: async (to: AddressType, data: CallDataType): Promise<Result<CallDataType, RpcError>> => {
        seen.push(bytesToHex(data).toLowerCase());
        return rpc.call(to, data, undefined as never);
      },
    };
    const read = createTokenMetadataReader(capturing);
    await read(TOKEN);
    const expectedSymbol = keccak256HexOfUtf8("symbol()").slice(0, 10).toLowerCase();
    const expectedName = keccak256HexOfUtf8("name()").slice(0, 10).toLowerCase();
    expect(seen).toContain(expectedSymbol);
    expect(seen).toContain(expectedName);
  });

  test("a reverting symbol stays null while the name fills", async () => {
    const rpc = stubRpc(new Map([["0x06fdde03", abiString("Token")]]));
    const read = createTokenMetadataReader(rpc);
    expect(await read(TOKEN)).toEqual({ symbol: null, name: "Token" });
  });
});

