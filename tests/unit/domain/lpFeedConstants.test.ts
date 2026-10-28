// Feed constants: factories, quote tokens and topic0 values (S-086,
// K-039). Test-first: these tests fail until src/domain/lpFeed.ts lands.
import { describe, expect, test } from "vitest";
import { keccak256HexOfUtf8 } from "../../../src/domain/types.ts";
import {
  ETH_ZERO_ADDRESS,
  FEED_FACTORIES,
  QUOTE_TOKENS,
  V2_PAIR_CREATED_SIG,
  V2_PAIR_CREATED_TOPIC0,
  V3_POOL_CREATED_SIG,
  V3_POOL_CREATED_TOPIC0,
  V4_INITIALIZE_SIG,
  V4_INITIALIZE_TOPIC0,
  resolveNewToken,
} from "../../../src/domain/lpFeed.ts";

// Synthetic WETH stand-in for tests (S-086): the literal mainnet WETH
// address must never appear in any tracked file, so tests use this
// fixture address as the configured WETH quote. Both fixtures below are
// fixed keccak256-of-label values, never repeated-digit patterns.
const SYNTHETIC_WETH = "0x774064f309727958148efe603d8aa92896c455bd";
const SYNTHETIC_ASSET = "0x419174f249096c659f013ccdc3d233c330bd803c";

describe("feed constants", () => {
  test("k039_topic0_match_viem_selector_and_pinned_constants", () => {
    expect(keccak256HexOfUtf8(V2_PAIR_CREATED_SIG)).toBe(V2_PAIR_CREATED_TOPIC0);
    expect(keccak256HexOfUtf8(V3_POOL_CREATED_SIG)).toBe(V3_POOL_CREATED_TOPIC0);
    expect(keccak256HexOfUtf8(V4_INITIALIZE_SIG)).toBe(V4_INITIALIZE_TOPIC0);
    expect(V2_PAIR_CREATED_TOPIC0).toBe(
      "0x0d3648bd0f6ba80134a33ba9275ac585d9d315f0ad8355cddefde31afa28d0e9",
    );
    expect(V3_POOL_CREATED_TOPIC0).toBe(
      "0x783cca1c0412dd0d695e784568c96da2e9c22ff989357a2e8b1d9b2b4e6b7118",
    );
    expect(V4_INITIALIZE_TOPIC0).toBe(
      "0xdd466e674ea557f56295e2d0218a125ea4b4f0f6f3307b95f85e6110838d6438",
    );
  });

  test("k039_factories_match_mainnet_addresses_without_live_calls", () => {
    const enabled = FEED_FACTORIES.filter((factory) => factory.enabledByDefault);
    expect(enabled).toHaveLength(7);
    const byDex = new Map(enabled.map((factory) => [factory.dex, factory.address.toLowerCase()]));
    expect(byDex.get("uniswap-v2")).toBe("0x5c69bee701ef814a2b6a3edd4b1652cb9cc5aa6f");
    expect(byDex.get("uniswap-v3")).toBe("0x1f98431c8ad98523631ae4a59f267346ea31f984");
    expect(byDex.get("uniswap-v4")).toBe("0x000000000004444c5dc75cb358380d2e3de08a90");
    expect(byDex.get("sushiswap-v2")).toBe("0xc0aee478e3658e2610c5f7a4a2e1777ce9e4f2ac");
    expect(byDex.get("sushiswap-v3")).toBe("0xbaceb8ec6b9355dfc0269c18bac9d6e2bdc29c4f");
    expect(byDex.get("pancakeswap-v2")).toBe("0x1097053fd2ea711dad45caccc45ef7548fcb362");
    expect(byDex.get("pancakeswap-v3")).toBe("0x0bfbcf9fa4f9c56b0f40a671ad40e0805a091");
    const kinds = new Map(enabled.map((factory) => [factory.dex, factory.kind]));
    expect(kinds.get("uniswap-v2")).toBe("v2");
    expect(kinds.get("uniswap-v3")).toBe("v3");
    expect(kinds.get("uniswap-v4")).toBe("v4");
  });

  test("k039_quote_tokens_identify_new_token_side", () => {
    const quotes = { ...QUOTE_TOKENS, weth: SYNTHETIC_WETH };
    for (const quote of [QUOTE_TOKENS.usdc, QUOTE_TOKENS.usdt, QUOTE_TOKENS.dai, SYNTHETIC_WETH]) {
      const tokenFirst = resolveNewToken(SYNTHETIC_ASSET, quote, { ...quotes, allowNativeZero: false });
      expect(tokenFirst).toEqual({ kind: "new-token", tokenAddress: SYNTHETIC_ASSET.toLowerCase() });
      const quoteFirst = resolveNewToken(quote, SYNTHETIC_ASSET, { ...quotes, allowNativeZero: false });
      expect(quoteFirst).toEqual({ kind: "new-token", tokenAddress: SYNTHETIC_ASSET.toLowerCase() });
    }
    const nativeV4 = resolveNewToken(ETH_ZERO_ADDRESS, SYNTHETIC_ASSET, { ...quotes, allowNativeZero: true });
    expect(nativeV4).toEqual({ kind: "new-token", tokenAddress: SYNTHETIC_ASSET.toLowerCase() });
  });
});
