import { describe, expect, test } from "vitest";
import { isValidAddress, normalizeAddress, validationMessage } from "./validate.ts";

describe("contract address validation (K-020)", () => {
  test("k020_valid_address_passes", () => {
    expect(isValidAddress("0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef")).toBe(true);
    expect(isValidAddress("0x0000000000000000000000000000000000000000")).toBe(true);
  });

  test("k020_invalid_address_fails_with_message", () => {
    for (const raw of ["", "0x123", "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef", "0xZZZZ567890abcdef1234567890ABCDEF12345678", "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbee ", "hello"]) {
      expect(isValidAddress(raw)).toBe(false);
      expect(validationMessage(raw).length).toBeGreaterThan(0);
    }
    expect(validationMessage("")).toContain("Address must start with 0x");
  });

  test("k020_whitespace_is_trimmed_before_validation", () => {
    expect(normalizeAddress("  0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef\n")).toBe(
      "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
    );
  });
});
