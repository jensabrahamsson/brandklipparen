// VS-B2 verified-source transforms: hidden-character markers, the
// declaration tokenizer and ABI-to-selector mapping. All fixtures below
// are hand-assembled synthetic shapes for tests only.
import { describe, expect, test } from "vitest";
import { keccak256HexOfUtf8 } from "../../../src/domain/types.ts";
import {
  applySourceSizeCap,
  extractSourceDeclarations,
  mapSourceFunctions,
  markHiddenSourceChars,
  normalizeSourceContent,
} from "../../../src/application/verifiedSource.ts";
import { mapRegistryMatch } from "../../../src/adapters/source/sourcifyAdapter.ts";

describe("verified-source hidden-character markers (VS-B2)", () => {
  test("vsb2_hidden_characters_render_as_visible_markers", () => {
    const marked = markHiddenSourceChars("a\u202eb\u200fc\u200dd");
    expect(marked).toBe("a[[U+202E]]b[[U+200F]]c[[U+200D]]d");
  });

  test("vsb2_registry_match_words_map_to_full_and_partial", () => {
    expect(mapRegistryMatch("exact_match")).toBe("full");
    expect(mapRegistryMatch("match")).toBe("partial");
    expect(mapRegistryMatch("full")).toBe("full");
    expect(mapRegistryMatch("partial")).toBe("partial");
    expect(mapRegistryMatch("unknown")).toBeNull();
    expect(mapRegistryMatch(null)).toBeNull();
  });

  test("vsb2_crlf_and_cr_fold_to_lf_before_processing", () => {
    expect(normalizeSourceContent("a\r\nb\rc")).toBe("a\nb\nc");
    expect(normalizeSourceContent("line one\r\n\tline two\r\n")).toBe("line one\n\tline two\n");
  });

  test("vsb2_cr_never_renders_as_a_marker", () => {
    const declarations = extractSourceDeclarations("contract A {\r\n    function ping() public {}\r\n}\r\n");
    expect(declarations).toHaveLength(1);
    expect(markHiddenSourceChars(normalizeSourceContent("a\r\nb\rc"))).toBe("a\nb\nc");
  });

  test("vsb2_leading_bom_is_stripped_while_inner_nul_is_marked", () => {
    expect(normalizeSourceContent("\ufeffcontract A {}")).toBe("contract A {}");
    expect(markHiddenSourceChars(normalizeSourceContent("a\u0000b"))).toBe("a[[U+0000]]b");
  });

  test("vsb2_ordinary_separators_pass_through_unmarked", () => {
    expect(markHiddenSourceChars("a\u00adb\u071cc\u2028d\u2029e")).toBe("a\u00adb\u071cc\u2028d\u2029e");
  });

  test("vsb2_bidi_and_zero_width_controls_render_as_markers", () => {
    expect(markHiddenSourceChars("\u202ax\u202cy\u2066z\u2067w\u2068v")).toBe("[[U+202A]]x[[U+202C]]y[[U+2066]]z[[U+2067]]w[[U+2068]]v");
  });

  test("vsb2_inner_feff_and_embeds_mark_via_charcode", () => {
    expect(markHiddenSourceChars("a" + String.fromCharCode(0xfeff) + "b")).toBe("a[[U+FEFF]]b");
    expect(markHiddenSourceChars("x" + String.fromCharCode(0x202b) + "y")).toBe("x[[U+202B]]y");
    expect(markHiddenSourceChars("p" + String.fromCharCode(0x200f) + "q")).toBe("p[[U+200F]]q");
    expect(markHiddenSourceChars("m" + String.fromCharCode(0x200b) + "n")).toBe("m[[U+200B]]n");
    expect(markHiddenSourceChars("s" + String.fromCharCode(0x2069) + "t")).toBe("s[[U+2069]]t");
    expect(markHiddenSourceChars("d" + String.fromCharCode(0x007f) + "e")).toBe("d[[U+007F]]e");
    expect(markHiddenSourceChars("f" + String.fromCharCode(0x009f) + "g")).toBe("f[[U+009F]]g");
  });

  test("vsb2_newlines_and_tabs_stay_structural", () => {
    expect(markHiddenSourceChars("line one\n\tline two")).toBe("line one\n\tline two");
  });

  test("vsb2_control_characters_render_as_markers", () => {
    expect(markHiddenSourceChars("x\u0001y")).toBe("x[[U+0001]]y");
  });
});

describe("verified-source declaration tokenizer (VS-B2)", () => {
  // Hand-assembled synthetic contract: the comment and the string each
  // name a `function` that must not match; the two real declarations
  // carry known 1-based ranges.
  const SOURCE = [
    "// SPDX-License-Identifier: MIT",
    "pragma solidity ^0.8.20;",
    "contract FixtureToken {",
    "    mapping(address => uint256) private balances;",
    '    string private note = "function nope(uint256 x)";',
    "    // function transfer(address,uint256) is below",
    "    function transfer(address to, uint256 amount) public returns (bool) {",
    "        balances[to] += amount;",
    "        return true;",
    "    }",
    "    function balanceOf(address account) public view returns (uint256) {",
    "        return balances[account];",
    "    }",
    "}",
  ].join("\n");

  test("vsb2_tokenizer_skips_comments_and_strings", () => {
    const declarations = extractSourceDeclarations(SOURCE);
    expect(declarations.map((entry) => entry.name)).toEqual(["transfer", "balanceOf"]);
  });

  test("vsb2_tokenizer_reports_source_ranges", () => {
    const declarations = extractSourceDeclarations(SOURCE);
    expect(declarations[0]).toMatchObject({ name: "transfer", startLine: 7, endLine: 10 });
    expect(declarations[1]).toMatchObject({ name: "balanceOf", startLine: 11, endLine: 13 });
  });

  test("vsb2_tokenizer_handles_bodyless_declarations", () => {
    const source = [
      "interface FixtureFace {",
      "    function totalSupply() external view returns (uint256);",
      "}",
    ].join("\n");
    const declarations = extractSourceDeclarations(source);
    expect(declarations).toHaveLength(1);
    expect(declarations[0]).toMatchObject({ name: "totalSupply", startLine: 2, endLine: 2 });
  });

  test("vsb2_tokenizer_handles_crlf_modifiers_and_multiline_params", () => {
    // Hand-assembled flattened-style source: CRLF endings, a leading
    // BOM, modifiers split across lines, comments and strings holding
    // decoy `function` text, and parameters over several lines.
    const source = [
      "// File: contracts/FlatToken.sol",
      "contract FlatToken {",
      "    // function decoy(uint256 x) is only a comment",
      '    string private note = "function nope(uint256 x)";',
      "    function transfer(",
      "        address to,",
      "        uint256 amount",
      "    )",
      "        public",
      "        virtual",
      "        override",
      "        returns (bool)",
      "    {",
      "        return true;",
      "    }",
      "}",
    ].join("\n").split("\n").join("\r\n");
    const declarations = extractSourceDeclarations(String.fromCharCode(0xfeff) + source);
    expect(declarations.map((entry) => entry.name)).toEqual(["transfer"]);
    expect(declarations[0]).toMatchObject({ name: "transfer", startLine: 5, endLine: 15 });
    expect(declarations[0]?.paramsText.replace(/\s+/g, " ").trim()).toBe("address to, uint256 amount");
  });
});

describe("verified-source ABI mapping (VS-B2)", () => {
  test("vsb2_abi_functions_map_to_selectors_and_ranges", () => {
    const declarations = [
      { file: "contracts/FixtureToken.sol", name: "transfer", paramsText: "address to, uint256 amount", startLine: 7, endLine: 10 },
      { file: "contracts/FixtureToken.sol", name: "balanceOf", paramsText: "address account", startLine: 11, endLine: 13 },
    ];
    const abi = [
      { type: "function", name: "transfer", inputs: [{ type: "address" }, { type: "uint256" }], stateMutability: "nonpayable" },
      { type: "function", name: "balanceOf", inputs: [{ type: "address" }], stateMutability: "view" },
      { type: "function", name: "totalSupply", inputs: [], stateMutability: "view" },
      { type: "event", name: "Transfer", inputs: [] },
      { type: "garbage" },
    ];
    const mapped = mapSourceFunctions(abi, declarations);
    // totalSupply has no located declaration, so it stays out: the UI
    // only shows matching functions. Events and malformed entries never
    // map.
    expect(mapped.map((entry) => entry.name)).toEqual(["balanceOf", "transfer"]);
    const transfer = mapped.find((entry) => entry.name === "transfer");
    expect(transfer).toMatchObject({
      selector: keccak256HexOfUtf8("transfer(address,uint256)").slice(0, 10),
      file: "contracts/FixtureToken.sol",
      startLine: 7,
      endLine: 10,
      signature: "transfer(address,uint256)",
    });
    const balanceOf = mapped.find((entry) => entry.name === "balanceOf");
    expect(balanceOf).toMatchObject({
      selector: keccak256HexOfUtf8("balanceOf(address)").slice(0, 10),
      signature: "balanceOf(address)",
    });
  });

  test("vsb2_overloads_pair_by_arity_in_order", () => {
    const declarations = [
      { file: "a.sol", name: "ping", paramsText: "uint256 x", startLine: 2, endLine: 4 },
      { file: "a.sol", name: "ping", paramsText: "uint256 x, uint256 y", startLine: 5, endLine: 7 },
    ];
    const abi = [
      { type: "function", name: "ping", inputs: [{ type: "uint256" }, { type: "uint256" }] },
      { type: "function", name: "ping", inputs: [{ type: "uint256" }] },
    ];
    const mapped = mapSourceFunctions(abi, declarations);
    expect(mapped).toHaveLength(2);
    expect(mapped[0]).toMatchObject({
      signature: "ping(uint256,uint256)",
      selector: keccak256HexOfUtf8("ping(uint256,uint256)").slice(0, 10),
      startLine: 5,
    });
    expect(mapped[1]).toMatchObject({
      signature: "ping(uint256)",
      selector: keccak256HexOfUtf8("ping(uint256)").slice(0, 10),
      startLine: 2,
    });
  });
});

describe("verified-source size cap (VS-B2)", () => {
  test("vsb2_size_cap_keeps_paths_with_empty_content", () => {
    const files = [
      { path: "a.sol", content: "contract A {}" },
      { path: "b.sol", content: "contract B {}" },
    ];
    const capped = applySourceSizeCap(files, 14);
    expect(capped).toEqual([
      { path: "a.sol", content: "contract A {}" },
      { path: "b.sol", content: "" },
    ]);
  });
});
