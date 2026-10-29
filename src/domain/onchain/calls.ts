// eth_call encoding and decoding for the on-chain reads (session A).
// Pure domain module: calldata builders for the no-arg and
// single-address reads plus decoders for 32-byte answer words. The drivers
// fetch through RpcPort; everything here is hex manipulation only.
import {
  BALANCE_OF_SELECTOR,
  GET_PAIR_SELECTOR,
  GET_RESERVES_SELECTOR,
  MASTER_COPY_SELECTOR,
  OWNER_SELECTOR,
  TOKEN0_SELECTOR,
  TOKEN1_SELECTOR,
  TOTAL_SUPPLY_SELECTOR,
  V3_LIQUIDITY_SELECTOR,
} from "./topics.ts";

function paddedAddress(address: string): string {
  const body = address.startsWith("0x") ? address.slice(2) : address;
  return body.toLowerCase().padStart(64, "0");
}

export function ownerCallData(): string {
  return OWNER_SELECTOR;
}

export function totalSupplyCallData(): string {
  return TOTAL_SUPPLY_SELECTOR;
}

export function balanceOfCallData(holder: string): string {
  return `${BALANCE_OF_SELECTOR}${paddedAddress(holder)}`;
}

export function getReservesCallData(): string {
  return GET_RESERVES_SELECTOR;
}

export function token0CallData(): string {
  return TOKEN0_SELECTOR;
}

export function token1CallData(): string {
  return TOKEN1_SELECTOR;
}

export function getPairCallData(tokenA: string, tokenB: string): string {
  return `${GET_PAIR_SELECTOR}${paddedAddress(tokenA)}${paddedAddress(tokenB)}`;
}

export function liquidityCallData(): string {
  return V3_LIQUIDITY_SELECTOR;
}

export function masterCopyCallData(): string {
  return MASTER_COPY_SELECTOR;
}

function wordOf(hex: string): string | null {
  const body = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (body.length !== 64 || !/^[0-9a-fA-F]{64}$/.test(body)) {
    return null;
  }
  return body.toLowerCase();
}

// An address carried in the low 20 bytes of a 32-byte answer word.
export function decodeAddressWord(hex: string): string | null {
  const word = wordOf(hex);
  if (word === null) {
    return null;
  }
  return `0x${word.slice(24)}`;
}

// A uint256 carried in a 32-byte answer word, or null when malformed.
export function decodeUint256(hex: string): bigint | null {
  const word = wordOf(hex);
  if (word === null) {
    return null;
  }
  try {
    return BigInt(`0x${word}`);
  } catch {
    return null;
  }
}

// V2 getReserves() answer: two uint112 reserves in the first two words
// (the third word is the timestamp and is ignored here).
export function decodeReserves(hex: string): { readonly reserve0: bigint; readonly reserve1: bigint } | null {
  const body = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (body.length !== 192 || !/^[0-9a-fA-F]{192}$/.test(body)) {
    return null;
  }
  try {
    return Object.freeze({
      reserve0: BigInt(`0x${body.slice(0, 64)}`),
      reserve1: BigInt(`0x${body.slice(64, 128)}`),
    });
  } catch {
    return null;
  }
}
