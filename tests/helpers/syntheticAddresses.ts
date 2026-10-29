// Clearly synthetic addresses and transaction hashes for tests only.
// Every value carries a fixed synthetic marker, so no literal here can
// be mistaken for a real mainnet address: `syntheticAddress` keeps the
// "0102030405" prefix with the index in the trailing hex, and
// `syntheticTxHash` is the zero-padded index. Production code never
// imports this module; WETH still arrives from BK_WETH_ADDRESS.
const SYNTHETIC_ADDRESS_PREFIX = "0102030405";

export function syntheticAddress(index: number): string {
  return `0x${SYNTHETIC_ADDRESS_PREFIX}${index.toString(16).padStart(30, "0")}`;
}

export function syntheticTxHash(index: number): string {
  return `0x${index.toString(16).padStart(64, "0")}`;
}
