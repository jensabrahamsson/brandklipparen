// Tests for the strict ERC-20 symbol()/name() text decoder: printable
// ASCII only, trimmed, at most 32 characters, bytes32 legacy form
// supported, absent (null) on every hostile or malformed payload.
import { describe, expect, test } from "vitest";
import { decodeTokenText, decodeTokenTextDisplay } from "../../../src/domain/tokenMetadata.ts";

function ascii(text: string): number[] {
  return [...text].map((char) => char.charCodeAt(0));
}

function abiString(text: string): Uint8Array {
  const bytes = ascii(text);
  const out: number[] = [
    ...new Array(31).fill(0),
    32,
    ...new Array(31).fill(0),
    bytes.length,
    ...bytes,
  ];
  while (out.length % 32 !== 0) {
    out.push(0);
  }
  return Uint8Array.from(out);
}

function bytes32(text: string): Uint8Array {
  const bytes = ascii(text);
  while (bytes.length < 32) {
    bytes.push(0);
  }
  return Uint8Array.from(bytes);
}

describe("strict token text decoding", () => {
  test("abi string form decodes", () => {
    expect(decodeTokenText(abiString("TEST"))).toBe("TEST");
  });

  test("bytes32 legacy form decodes", () => {
    expect(decodeTokenText(bytes32("SYM"))).toBe("SYM");
  });

  test("surrounding spaces trim", () => {
    expect(decodeTokenText(abiString("  ABC  "))).toBe("ABC");
  });

  test("overlong text is absent", () => {
    expect(decodeTokenText(abiString("A".repeat(33)))).toBeNull();
  });

  test("non-printable bytes are absent in both forms", () => {
    const hostile = abiString("AB");
    hostile[64] = 0x01;
    expect(decodeTokenText(hostile)).toBeNull();
    const hostile32 = bytes32("AB");
    hostile32[1] = 0x7f;
    expect(decodeTokenText(hostile32)).toBeNull();
    const high = bytes32("AB");
    high[0] = 0x80;
    expect(decodeTokenText(high)).toBeNull();
  });

  test("empty text is absent", () => {
    expect(decodeTokenText(abiString(""))).toBeNull();
    expect(decodeTokenText(new Uint8Array(32))).toBeNull();
  });

  test("display decoding keeps ASCII plain and flags homoglyph text", () => {
    expect(decodeTokenTextDisplay(abiString("TEST"))).toEqual({ text: "TEST", nonAscii: false });
    // Cyrillic small letter te (U+0442) in place of the final T.
    const homoglyph = new TextEncoder().encode("USD\u0442");
    const out: number[] = [
      ...new Array(31).fill(0),
      32,
      ...new Array(31).fill(0),
      homoglyph.length,
      ...homoglyph,
    ];
    while (out.length % 32 !== 0) {
      out.push(0);
    }
    expect(decodeTokenTextDisplay(Uint8Array.from(out))).toEqual({ text: "USD\u0442", nonAscii: true });
    expect(decodeTokenText(Uint8Array.from(out))).toBeNull();
  });

  test("display decoding stays absent for controls", () => {
    const hostile = abiString("AB");
    hostile[64] = 0x01;
    expect(decodeTokenTextDisplay(hostile)).toBeNull();
  });

  test("display decoding shows broken UTF-8 lossily and flagged instead of empty", () => {
    const broken: number[] = [
      ...new Array(31).fill(0),
      32,
      ...new Array(31).fill(0),
      2,
      0xd1,
      0x41,
    ];
    while (broken.length % 32 !== 0) {
      broken.push(0);
    }
    expect(decodeTokenTextDisplay(Uint8Array.from(broken))).toEqual({
      text: "\uFFFD" + "A",
      nonAscii: true,
    });
    expect(decodeTokenText(Uint8Array.from(broken))).toBeNull();
  });

  test("malformed payloads are absent", () => {
    // Wrong offset word.
    const wrong = abiString("AB");
    wrong[31] = 0;
    expect(decodeTokenText(wrong)).toBeNull();
    // Declared length past the end.
    const truncated = abiString("AB").slice(0, 65);
    expect(decodeTokenText(truncated)).toBeNull();
    // Too short for either form.
    expect(decodeTokenText(Uint8Array.from([0x01, 0x02]))).toBeNull();
  });
});
