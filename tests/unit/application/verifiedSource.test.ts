// VS-B2 verified-source transforms: hidden-character markers, the
// declaration tokenizer and ABI-to-selector mapping. All fixtures below
// are hand-assembled synthetic shapes for tests only.
import { describe, expect, test } from "vitest";
import { err, ok } from "../../../src/domain/result.ts";
import type { Result } from "../../../src/domain/result.ts";
import type {
  BlockNumber as BlockNumberType,
  RequestId as RequestIdType,
  Timestamp as TimestampType,
} from "../../../src/domain/types.ts";
import {
  Address,
  BlockNumber,
  RequestId,
  Timestamp,
  keccak256HexOfUtf8,
} from "../../../src/domain/types.ts";
import type { ClockPort } from "../../../src/ports/clock.ts";
import type {
  VerifiedSourceFetchError,
  VerifiedSourcePort,
  VerifiedSourceRaw,
} from "../../../src/ports/verifiedSource.ts";
import {
  VERIFIED_SOURCE_NONE_TTL_MS,
  applySourceSizeCap,
  createVerifiedSourceService,
  extractSourceDeclarations,
  mapSourceFunctions,
  markHiddenSourceChars,
  normalizeSourceContent,
} from "../../../src/application/verifiedSource.ts";
import { mapRegistryMatch } from "../../../src/adapters/source/sourcifyAdapter.ts";
import { FakeRpcAdapter } from "../../fakes/fakeRpc.ts";

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

describe("verified-source override ranking (C-25)", () => {
  // Hand-assembled synthetic shapes: an OZ-style base with a virtual
  // body, a bodiless interface, and a scam override holding the hidden
  // logic. The compilation target names the scam contract.
  const BASE_SOURCE = [
    "// SPDX-License-Identifier: MIT",
    "pragma solidity ^0.8.20;",
    "contract ERC20 {",
    "    function transfer(address to, uint256 amount) public virtual returns (bool) {",
    "        return true;",
    "    }",
    "}",
  ].join("\n");
  const INTERFACE_SOURCE = [
    "// SPDX-License-Identifier: MIT",
    "pragma solidity ^0.8.20;",
    "interface IERC20 {",
    "    function transfer(address to, uint256 amount) external returns (bool);",
    "}",
  ].join("\n");
  const SCAM_SOURCE = [
    "// SPDX-License-Identifier: MIT",
    "pragma solidity ^0.8.20;",
    "contract Scam is ERC20 {",
    "    function transfer(address to, uint256 amount) public override returns (bool) {",
    "        return true;",
    "    }",
    "}",
  ].join("\n");
  const TRANSFER_ABI = [
    { type: "function", name: "transfer", inputs: [{ type: "address" }, { type: "uint256" }] },
  ];
  const TARGET = { path: "contracts/Scam.sol", contractName: "Scam" };

  function scamDeclarations(): Array<{
    file: string;
    name: string;
    paramsText: string;
    startLine: number;
    endLine: number;
    hasBody: boolean;
    isOverride: boolean;
    contractName: string | null;
    contractKind: "contract" | "library" | "interface" | null;
  }> {
    return [
      ...extractSourceDeclarations(BASE_SOURCE).map((declaration) => ({
        ...declaration,
        file: "@openzeppelin/contracts/token/ERC20/ERC20.sol",
      })),
      ...extractSourceDeclarations(INTERFACE_SOURCE).map((declaration) => ({
        ...declaration,
        file: "contracts/IERC20.sol",
      })),
      ...extractSourceDeclarations(SCAM_SOURCE).map((declaration) => ({
        ...declaration,
        file: "contracts/Scam.sol",
      })),
    ];
  }

  test("c25_override_body_wins_over_base_and_interface", () => {
    const mapped = mapSourceFunctions(TRANSFER_ABI, scamDeclarations(), TARGET);
    expect(mapped).toHaveLength(1);
    expect(mapped[0]).toMatchObject({
      file: "contracts/Scam.sol",
      startLine: 4,
      endLine: 6,
      signature: "transfer(address,uint256)",
      selector: keccak256HexOfUtf8("transfer(address,uint256)").slice(0, 10),
    });
  });

  test("c25_without_target_prefers_bodied_override", () => {
    const mapped = mapSourceFunctions(TRANSFER_ABI, scamDeclarations(), null);
    expect(mapped).toHaveLength(1);
    expect(mapped[0]).toMatchObject({ file: "contracts/Scam.sol", startLine: 4 });
  });

  test("c25_interface_never_beats_body", () => {
    const declarations = [
      ...extractSourceDeclarations(INTERFACE_SOURCE).map((declaration) => ({
        ...declaration,
        file: "contracts/IERC20.sol",
      })),
      ...extractSourceDeclarations(BASE_SOURCE).map((declaration) => ({
        ...declaration,
        file: "contracts/Plain.sol",
      })),
    ];
    const mapped = mapSourceFunctions(TRANSFER_ABI, declarations, null);
    expect(mapped).toHaveLength(1);
    expect(mapped[0]).toMatchObject({ file: "contracts/Plain.sol" });
  });

  test("c25_large_file_linear", () => {
    // 5,000 synthetic functions over about 50,000 lines: the binary
    // line search keeps the scan near-linear.
    const lines: string[] = ["contract Big {"];
    for (let index = 0; index < 5000; index += 1) {
      lines.push(`    function fn${index}(uint256 x) public returns (uint256) {`);
      for (let body = 0; body < 8; body += 1) {
        lines.push(`        uint256 y${body} = x + ${body};`);
      }
      lines.push("        return x;");
      lines.push("    }");
    }
    lines.push("}");
    const started = Date.now();
    const declarations = extractSourceDeclarations(lines.join("\n"));
    const elapsed = Date.now() - started;
    expect(declarations).toHaveLength(2000);
    expect(elapsed).toBeLessThan(200);
  });
});

describe("verified-source memo behaviour (C-25)", () => {
  const BYTECODE = "0x6080604052348015600e575f5ffd5b50603e80601a5f395ff3";
  const ADDRESS_A = "0x0102030405060708090a0b0c0d0e0f1011121314";
  const ADDRESS_B = `0x${"ab".repeat(20)}`;
  const ABI = [
    { type: "function", name: "transfer", inputs: [{ type: "address" }, { type: "uint256" }] },
  ];

  function must<T, E extends { message: string }>(result: Result<T, E>): T {
    if (!result.ok) {
      throw new Error(`expected ok: ${result.error.message}`);
    }
    return result.value;
  }

  function mutableClock(start: number): { clock: ClockPort; advance: (ms: number) => void } {
    let now = start;
    return {
      clock: { now: () => must(Timestamp.of(now)) },
      advance: (ms: number): void => {
        now += ms;
      },
    };
  }

  function rpcFor(addresses: readonly string[]): FakeRpcAdapter {
    const codes = new Map<string, string>();
    for (const address of addresses) {
      codes.set(must(Address.parse(address)) as string, BYTECODE);
    }
    return new FakeRpcAdapter(codes, must(BlockNumber.of(18000000)));
  }

  function ctx(): { requestId: RequestIdType; deadline: TimestampType; block: BlockNumberType } {
    return {
      requestId: must(RequestId.parse("123e4567-e89b-12d3-a456-426614174000")),
      deadline: must(Timestamp.of(1800000000000)),
      block: must(BlockNumber.of(18000000)),
    };
  }

  function verifiedPort(calls: { count: number }, files: { path: string; content: string }[]): VerifiedSourcePort {
    return {
      fetchVerifiedSource: async (): Promise<Result<VerifiedSourceRaw, VerifiedSourceFetchError>> => {
        calls.count += 1;
        return ok({
          status: "verified",
          provider: "sourcify",
          match: "full",
          compiler: "0.8.20+commit.a1b79de6",
          files,
          abi: ABI,
          compilationTarget: null,
        });
      },
    };
  }

  test("c25_same_code_other_address_not_shared", async () => {
    const calls = { count: 0 };
    const service = createVerifiedSourceService({
      primary: verifiedPort(calls, [{ path: "A.sol", content: "contract A {}" }]),
      rpc: rpcFor([ADDRESS_A, ADDRESS_B]),
      clock: mutableClock(1700000000000).clock,
    });
    const first = await service.getSource(must(Address.parse(ADDRESS_A)), ctx());
    const second = await service.getSource(must(Address.parse(ADDRESS_B)), ctx());
    expect(first.ok && second.ok).toBe(true);
    expect(calls.count).toBe(2);
  });

  test("c25_unavailable_not_cached", async () => {
    const calls = { count: 0 };
    const failing: VerifiedSourcePort = {
      fetchVerifiedSource: async () => {
        calls.count += 1;
        return err({ kind: "unavailable", message: "synthetic transport failure" });
      },
    };
    const service = createVerifiedSourceService({
      primary: failing,
      rpc: rpcFor([ADDRESS_A]),
      clock: mutableClock(1700000000000).clock,
    });
    const first = await service.getSource(must(Address.parse(ADDRESS_A)), ctx());
    const second = await service.getSource(must(Address.parse(ADDRESS_A)), ctx());
    expect(first.ok && second.ok).toBe(true);
    if (first.ok && second.ok) {
      expect(first.value.source.status).toBe("unavailable");
      expect(second.value.source.status).toBe("unavailable");
    }
    expect(calls.count).toBe(2);
  });

  test("c25_none_expires_after_ttl", async () => {
    const calls = { count: 0 };
    const empty: VerifiedSourcePort = {
      fetchVerifiedSource: async () => {
        calls.count += 1;
        return ok({
          status: "none",
          provider: "sourcify",
          match: null,
          compiler: null,
          files: [],
          abi: [],
          compilationTarget: null,
        });
      },
    };
    const time = mutableClock(1700000000000);
    const service = createVerifiedSourceService({
      primary: empty,
      rpc: rpcFor([ADDRESS_A]),
      clock: time.clock,
    });
    const address = must(Address.parse(ADDRESS_A));
    const first = await service.getSource(address, ctx());
    expect(first.ok && first.ok && first.value.source.status).toBe("none");
    const cached = await service.getSource(address, ctx());
    expect(cached.ok && cached.ok && cached.value.source.status).toBe("none");
    expect(calls.count).toBe(1);
    time.advance(VERIFIED_SOURCE_NONE_TTL_MS + 1);
    const refetched = await service.getSource(address, ctx());
    expect(refetched.ok && refetched.ok && refetched.value.source.status).toBe("none");
    expect(calls.count).toBe(2);
  });
});
