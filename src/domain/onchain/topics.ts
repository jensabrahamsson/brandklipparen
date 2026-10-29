// Point-in-time on-chain topics and selectors (session A).
// Pure domain module: event signatures from public protocol docs and
// function signatures from the ERC-20 and pool interfaces. Every topic is
// keccak256 of its signature and every selector is the first four bytes of
// keccak256 of its signature, computed here through the shared pure keccak
// helper. Nothing here is copied as a hash from elsewhere; tests recompute
// each value through keccak256HexOfUtf8, following the S-086 pin pattern.
import { keccak256HexOfUtf8 } from "../types.ts";

// Event signatures (public protocol docs: Uniswap V2 pair and factory
// docs, Uniswap V3 pool and factory docs, SushiSwap V2/V3 factory docs,
// the ERC-20 standard). Reused from the feed domain where pinned.
export const TRANSFER_EVENT_SIG = "Transfer(address,address,uint256)";
export const V2_PAIR_CREATED_SIG = "PairCreated(address,address,address,uint256)";
export const V2_MINT_SIG = "Mint(address,uint256,uint256)";
export const V2_SYNC_SIG = "Sync(uint112,uint112)";
export const V3_POOL_CREATED_SIG = "PoolCreated(address,address,uint24,int24,address)";
export const V3_MINT_SIG = "Mint(address,address,int24,int24,uint128,uint256,uint256)";

// ERC-20 and pool read signatures (public interface docs).
export const OWNER_FN_SIG = "owner()";
export const TOTAL_SUPPLY_FN_SIG = "totalSupply()";
export const BALANCE_OF_FN_SIG = "balanceOf(address)";
export const DECIMALS_FN_SIG = "decimals()";
export const GET_RESERVES_FN_SIG = "getReserves()";
export const TOKEN0_FN_SIG = "token0()";
export const TOKEN1_FN_SIG = "token1()";
export const GET_PAIR_FN_SIG = "getPair(address,address)";
export const V3_LIQUIDITY_FN_SIG = "liquidity()";
export const MASTER_COPY_FN_SIG = "masterCopy()";

// keccak256 of an event signature, 0x-prefixed lowercase: the topic0.
export function topicOf(signature: string): string {
  return keccak256HexOfUtf8(signature).toLowerCase();
}

// First four bytes of keccak256 of a function signature: the selector.
export function selectorOf(signature: string): string {
  return `0x${keccak256HexOfUtf8(signature).slice(2, 10).toLowerCase()}`;
}

export const TRANSFER_TOPIC = topicOf(TRANSFER_EVENT_SIG);
export const V2_PAIR_CREATED_TOPIC = topicOf(V2_PAIR_CREATED_SIG);
export const V2_MINT_TOPIC = topicOf(V2_MINT_SIG);
export const V2_SYNC_TOPIC = topicOf(V2_SYNC_SIG);
export const V3_POOL_CREATED_TOPIC = topicOf(V3_POOL_CREATED_SIG);
export const V3_MINT_TOPIC = topicOf(V3_MINT_SIG);

export const OWNER_SELECTOR = selectorOf(OWNER_FN_SIG);
export const TOTAL_SUPPLY_SELECTOR = selectorOf(TOTAL_SUPPLY_FN_SIG);
export const BALANCE_OF_SELECTOR = selectorOf(BALANCE_OF_FN_SIG);
export const DECIMALS_SELECTOR = selectorOf(DECIMALS_FN_SIG);
export const GET_RESERVES_SELECTOR = selectorOf(GET_RESERVES_FN_SIG);
export const TOKEN0_SELECTOR = selectorOf(TOKEN0_FN_SIG);
export const TOKEN1_SELECTOR = selectorOf(TOKEN1_FN_SIG);
export const GET_PAIR_SELECTOR = selectorOf(GET_PAIR_FN_SIG);
export const V3_LIQUIDITY_SELECTOR = selectorOf(V3_LIQUIDITY_FN_SIG);
export const MASTER_COPY_SELECTOR = selectorOf(MASTER_COPY_FN_SIG);

// An address as a 32-byte left-padded topic word, lowercase.
export function addressTopic(address: string): string {
  const body = address.startsWith("0x") ? address.slice(2) : address;
  return `0x${body.toLowerCase().padStart(64, "0")}`;
}

// The address carried by a 32-byte topic word, or null when malformed.
export function addressOfTopicWord(word: string): string | null {
  if (!/^0x[0-9a-fA-F]{64}$/.test(word)) {
    return null;
  }
  return `0x${word.slice(-40).toLowerCase()}`;
}

// True for the zero address and the canonical dead address: both count as
// renounced or burned wherever ownership or supply shares are classified.
export function isZeroOrDead(address: string): boolean {
  const lower = address.toLowerCase();
  return lower === "0x0000000000000000000000000000000000000000" ||
    lower === "0x000000000000000000000000000000000000dead";
}
