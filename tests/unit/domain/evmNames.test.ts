// Selector naming tests (S-080, K-037, K-521).
// Written first per A-21 (red): src/domain/evmNames.ts does not exist
// yet. The four published ERC-20 selectors resolve by table, unknown
// selectors stay raw, and the fallback rule overrides the table.
import { describe, expect, test } from "vitest";
import {
  SELECTOR_TABLE_VERSION,
  nameForSelector,
  resolveFunctionNames,
  tableRows,
  tableSignatureFor,
} from "../../../src/domain/evmNames.ts";
import { keccak256HexOfUtf8 } from "../../../src/domain/types.ts";

describe("evm selector naming", () => {
  test("k523_four_published_selectors_resolve", () => {
    expect(nameForSelector("0xa9059cbb", { isFallback: false })).toEqual({
      name: "transfer",
      signature: "transfer(address,uint256)",
      source: "table",
    });
    expect(nameForSelector("0x095ea7b3", { isFallback: false })).toEqual({
      name: "approve",
      signature: "approve(address,uint256)",
      source: "table",
    });
    expect(nameForSelector("0x23b872dd", { isFallback: false })).toEqual({
      name: "transferFrom",
      signature: "transferFrom(address,address,uint256)",
      source: "table",
    });
    expect(nameForSelector("0x70a08231", { isFallback: false })).toEqual({
      name: "balanceOf",
      signature: "balanceOf(address)",
      source: "table",
    });
  });

  test("k523_unknown_selector_stays_raw", () => {
    const named = nameForSelector("0xdeadbeef", { isFallback: false });
    expect(named.signature).toBe(null);
    expect(named.source).toBe("raw");
    expect(named.name).toContain("deadbeef");
  });

  test("k523_table_signature_overridden_by_rules", () => {
    const named = nameForSelector("0xa9059cbb", { isFallback: true });
    expect(named.name).toBe("fallback");
    expect(named.signature).toBe(null);
    expect(named.source).toBe("rule");
  });

  test("k523_resolve_function_names_marks_fallback_entries", () => {
    const entries = [
      { selector: "0xa9059cbb", entryPc: 100, entryBlock: 5, hasHalt: true },
      { selector: "0xdeadbeef", entryPc: 200, entryBlock: 9, hasHalt: true },
    ];
    const named = resolveFunctionNames(entries, 9);
    expect(named[0]?.named.source).toBe("table");
    expect(named[1]?.named.name).toBe("fallback");
  });

  test("m02e_table_version_is_pinned", () => {
    expect(SELECTOR_TABLE_VERSION).toBe("1.0.0");
  });

  test("m02e_every_table_selector_matches_keccak_of_its_signature", () => {
    const rows = tableRows();
    expect(rows.length).toBeGreaterThan(9);
    for (const row of rows) {
      const digest = keccak256HexOfUtf8(row.signature).toLowerCase();
      expect(`0x${digest.slice(2, 10)}`).toBe(row.selector.toLowerCase());
    }
  });

  test("m02e_known_admin_selectors_resolve_with_signatures", () => {
    expect(tableSignatureFor("0x8456cb59")).toBe("pause()");
    expect(tableSignatureFor("0xf2fde38b")).toBe("transferOwnership(address)");
    expect(tableSignatureFor("0x18160ddd")).toBe("totalSupply()");
    expect(tableSignatureFor("0x8da5cb5b")).toBe("owner()");
    expect(tableSignatureFor("0x40c10f19")).toBe("mint(address,uint256)");
    expect(tableSignatureFor("0xdeadbeef")).toBe(null);
    expect(tableSignatureFor("0x8456CB59")).toBe("pause()");
  });

  test("m02e_named_functions_label_decompiled_output", () => {
    expect(nameForSelector("0x8456cb59", { isFallback: false })).toEqual({
      name: "pause",
      signature: "pause()",
      source: "table",
    });
    expect(nameForSelector("0xf2fde38b", { isFallback: false }).name).toBe("transferOwnership");
  });
});
