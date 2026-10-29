// EIP-55 checksum helper: the hash core matches the empty-string
// Keccak-256 vector, and synthetic addresses pin their oracle-computed
// mixed case (python eth_hash Keccak of the lowercase ASCII body).
// Non-addresses pass through so shared copy rows never mangle labels
// or hashes.
import { describe, expect, it } from "vitest";
import { keccak256Hex, toChecksumAddress } from "./checksumAddress.ts";

describe("keccak256Hex", () => {
  it("matches the empty-string Keccak-256 vector", () => {
    expect(keccak256Hex("")).toBe("c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470");
  });
});

describe("toChecksumAddress", () => {
  it("checksums synthetic addresses to their oracle-computed form", () => {
    expect(toChecksumAddress("0x5ab1e0000000000000000000000000000000a001")).toBe(
      "0x5ab1E0000000000000000000000000000000a001",
    );
    expect(toChecksumAddress("0x5ab1e0000000000000000000000000000000b0bb")).toBe(
      "0x5ab1E0000000000000000000000000000000b0BB",
    );
    expect(toChecksumAddress("0xdeadbeef00000000000000000000000000c0de42")).toBe(
      "0xDeadbEEf00000000000000000000000000C0dE42",
    );
    expect(toChecksumAddress("0x5ab1e0000000000000000000000000000000a0aa")).toBe(
      "0x5aB1E0000000000000000000000000000000a0aa",
    );
  });

  it("is idempotent and accepts uppercase bodies", () => {
    const checksummed = "0x5ab1E0000000000000000000000000000000a001";
    expect(toChecksumAddress(checksummed)).toBe(checksummed);
    expect(toChecksumAddress("0x5AB1E0000000000000000000000000000000A001")).toBe(checksummed);
    const deadbeef = "0xDeadbEEf00000000000000000000000000C0dE42";
    expect(toChecksumAddress(deadbeef)).toBe(deadbeef);
    expect(toChecksumAddress("0xDEADBEEF00000000000000000000000000C0DE42")).toBe(deadbeef);
  });

  it("passes non-addresses through unchanged", () => {
    expect(toChecksumAddress("No proxy (direct implementation)")).toBe("No proxy (direct implementation)");
    expect(toChecksumAddress("0xabc")).toBe("0xabc");
    expect(toChecksumAddress("")).toBe("");
  });
});
