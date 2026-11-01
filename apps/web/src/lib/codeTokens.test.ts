// Tokeniser roles for the pause() example and the hex, hidden-char
// and contrast acceptance (addendum §A1.5). Behavior only: token
// roles, shortening rules and AA contrast on both line backgrounds.
// Hidden characters use String.fromCodePoint so the source holds no
// invisible bytes.
import { describe, expect, test } from "vitest";
import {
  CODE_ROLE_COLORS,
  HEX_SHORTEN_AT,
  hiddenChipText,
  isLongHex,
  shortHex,
  tokenizeCodeLine,
  type CodeRole,
} from "./codeTokens.ts";

const BIDI_OVERRIDE = String.fromCodePoint(0x202e);
const ZERO_WIDTH_SPACE = String.fromCodePoint(0x200b);

function rolesOf(line: string): Array<{ text: string; role: CodeRole }> {
  return tokenizeCodeLine(line).map((token) => ({ text: token.text, role: token.role }));
}

function roleMap(line: string): Map<string, CodeRole> {
  const map = new Map<string, CodeRole>();
  for (const token of tokenizeCodeLine(line)) {
    if (token.text.trim().length > 0) {
      map.set(token.text, token.role);
    }
  }
  return map;
}

describe("code tokeniser", () => {
  test("pause example roles", () => {
    const line = "function pause() /* selector 0x8456cb59 */ { require(msg.sender == owner); paused = true; emit 0x1234(); }";
    const map = roleMap(line);
    expect(map.get("function")).toBe("keyword");
    expect(map.get("pause")).toBe("name");
    expect(map.get("/* selector 0x8456cb59 */")).toBe("comment");
    expect(map.get("require")).toBe("keyword");
    expect(map.get("msg.sender")).toBe("builtin");
    expect(map.get("owner")).toBe("name");
    expect(map.get("paused")).toBe("name");
    expect(map.get("true")).toBe("keyword");
    expect(map.get("emit")).toBe("keyword");
    expect(map.get("0x1234")).toBe("literal");
    expect(map.get("{")).toBe("punctuation");
    expect(map.get("(")).toBe("punctuation");
  });

  test("literals, builtins and dotted storage names", () => {
    const map = roleMap("isBlackListed[a0] = true; require(block.timestamp > 100);");
    expect(map.get("isBlackListed")).toBe("name");
    expect(map.get("true")).toBe("keyword");
    expect(map.get("block.timestamp")).toBe("builtin");
    expect(map.get("100")).toBe("literal");
    expect(rolesOf("// safe, no owner").map((token) => token.role)).toEqual(["comment"]);
  });

  test("hex longer than 18 characters shortens for display only", () => {
    const full = `0x${"ab".repeat(32)}`;
    expect(full.length).toBeGreaterThan(HEX_SHORTEN_AT);
    expect(isLongHex(full)).toBe(true);
    const short = shortHex(full);
    expect(short).not.toBe(full);
    expect(short).toContain("…");
    expect(short.startsWith("0xababab")).toBe(true);
    expect(short.endsWith("abab")).toBe(true);
    expect(isLongHex("0x8456cb59")).toBe(false);
    expect(shortHex("0x8456cb59")).toBe("0x8456cb59");
  });

  test("bidi and zero-width characters tokenise as hidden", () => {
    const tokens = tokenizeCodeLine(`paused = true;${BIDI_OVERRIDE} // done`);
    const hidden = tokens.filter((token) => token.role === "hidden");
    expect(hidden).toHaveLength(1);
    expect(hiddenChipText(hidden[0]?.text ?? "")).toBe("⟨U+202E⟩");
    const zeroWidth = tokenizeCodeLine(`a${ZERO_WIDTH_SPACE}b`);
    expect(zeroWidth.filter((token) => token.role === "hidden")).toHaveLength(1);
    expect(hiddenChipText(ZERO_WIDTH_SPACE)).toBe("⟨U+200B⟩");
  });

  test("hidden characters split their own tokens around code", () => {
    const tokens = tokenizeCodeLine(`onlyOwner${BIDI_OVERRIDE} // safe`);
    const hidden = tokens.filter((token) => token.role === "hidden");
    expect(hidden.map((token) => hiddenChipText(token.text))).toEqual(["⟨U+202E⟩"]);
    expect(tokens.some((token) => token.text === "onlyOwner" && token.role === "name")).toBe(true);
    expect(tokens.some((token) => token.role === "comment")).toBe(true);
  });

  test("every role contrasts at least 4.5 to 1 on both line backgrounds", () => {
    const luminanceOf = (hex: string): number => {
      const channels = [1, 3, 5].map((at) => Number.parseInt(hex.slice(at, at + 2), 16) / 255);
      const linear = channels.map((value) =>
        value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4,
      );
      return 0.2126 * (linear[0] ?? 0) + 0.7152 * (linear[1] ?? 0) + 0.0722 * (linear[2] ?? 0);
    };
    const contrastOf = (first: string, second: string): number => {
      const a = luminanceOf(first);
      const b = luminanceOf(second);
      return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
    };
    for (const [role, color] of Object.entries(CODE_ROLE_COLORS) as Array<[CodeRole, string]>) {
      expect(contrastOf(color, "#03110A"), `${role} on glass`).toBeGreaterThanOrEqual(4.5);
      expect(contrastOf(color, "#0C2618"), `${role} on evidence line`).toBeGreaterThanOrEqual(4.5);
    }
  });
});
