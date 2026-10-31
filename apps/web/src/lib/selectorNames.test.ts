// Selector names for evidence rows (UI v2 §5.3): built from the
// decompiler payload of the same analysis, display only.
import { describe, expect, test } from "vitest";
import { buildSelectorNames, selectorDisplayName, selectorShortName } from "./selectorNames.ts";

describe("selector names from the decompiler payload", () => {
  test("prefers the signature, then the short name, then the fallback", () => {
    const names = buildSelectorNames([
      { payload: { selector: "0x095EA7B3", name: "approve", signature: "approve(address,uint256)" } },
      { payload: { selector: "0x70a08231", name: "balanceOf" } },
    ]);
    expect(selectorDisplayName("0x095ea7b3", names)).toBe("approve(address,uint256)");
    expect(selectorShortName("0x095ea7b3", names)).toBe("approve");
    expect(selectorDisplayName("0x70a08231", names)).toBe("balanceOf");
    expect(selectorDisplayName("0xdeadbeef", names)).toBe("function 0xdeadbeef");
  });

  test("ignores malformed payloads without dropping the valid ones", () => {
    const names = buildSelectorNames([
      { payload: null },
      { payload: { selector: "not-a-selector", name: "junk" } },
      { payload: { name: "missing selector" } },
      { payload: { selector: "0x40c10f19", name: "  ", signature: "" } },
    ]);
    expect(names.size).toBe(1);
    expect(selectorDisplayName("0x40c10f19", names)).toBe("function 0x40c10f19");
  });
});
