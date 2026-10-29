// Clearly synthetic addresses for web tests only. Every value carries
// a fixed synthetic marker, so no literal here can be mistaken for a
// real mainnet address: the "0102030405" prefix stays fixed and the
// index fills the trailing hex. Production code never imports this.
const SYNTHETIC_ADDRESS_PREFIX = "0102030405";

export function syntheticAddress(index: number): string {
  return `0x${SYNTHETIC_ADDRESS_PREFIX}${index.toString(16).padStart(30, "0")}`;
}
