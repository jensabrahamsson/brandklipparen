// DexScreener market listing adapter (DX-B1): discovery filtering,
// pair batching, invalid-item skipping, EIP-55 output, token bucket,
// timeouts, the response size cap and the allowlisted host. Recorded
// synthetic fixtures only; no live network, no real addresses.
import { describe, expect, test } from "vitest";
import { Address } from "../../../src/domain/types.ts";
import {
  DEXSCREENER_BASE_URL,
  DexscreenerMarketFeedAdapter,
  NotConfiguredMarketFeedAdapter,
  createMarketFeedAdapter,
} from "../../../src/adapters/market/dexscreenerAdapter.ts";
import type { DexscreenerTransportResponse } from "../../../src/adapters/market/dexscreenerAdapter.ts";
import { syntheticAddress } from "../../helpers/syntheticAddresses.ts";

const TOKEN_A = syntheticAddress(21);
const TOKEN_B = syntheticAddress(22);
const TOKEN_C = syntheticAddress(24);
const PAIR_A_OLD = syntheticAddress(31);
const PAIR_A_NEW = syntheticAddress(32);
const PAIR_B = syntheticAddress(33);

function checksum(raw: string): string {
  const parsed = Address.parse(raw);
  if (!parsed.ok) {
    throw new Error(`synthetic address must parse: ${raw}`);
  }
  return parsed.value as string;
}

function profilesBody(): string {
  return JSON.stringify([
    { url: "https://example.invalid/a", chainId: "ethereum", tokenAddress: TOKEN_A },
    { url: "https://example.invalid/b", chainId: "ethereum", tokenAddress: TOKEN_B },
    { url: "https://example.invalid/sol", chainId: "solana", tokenAddress: syntheticAddress(23) },
    { url: "https://example.invalid/bad", chainId: "ethereum", tokenAddress: "0xnotanaddress" },
  ]);
}

function boostsBody(): string {
  return JSON.stringify([
    { url: "https://example.invalid/b2", chainId: "ethereum", tokenAddress: TOKEN_B },
    { url: "https://example.invalid/c", chainId: "ethereum", tokenAddress: TOKEN_C },
  ]);
}

function pairsBody(): string {
  return JSON.stringify([
    {
      chainId: "ethereum",
      dexId: "uniswap",
      pairAddress: PAIR_A_OLD,
      baseToken: { address: TOKEN_A, name: "Alpha Token", symbol: "ALPHA" },
      quoteToken: { address: syntheticAddress(40), name: "Wrapped Ether", symbol: "WETH" },
      liquidity: { usd: 1000, base: 1, quote: 2 },
      volume: { h24: 500, h6: 100, h1: 10, m5: 1 },
      pairCreatedAt: 1700000000000,
    },
    {
      chainId: "ethereum",
      dexId: "uniswap",
      pairAddress: PAIR_A_NEW,
      baseToken: { address: TOKEN_A, name: "Alpha Token", symbol: "ALPHA" },
      quoteToken: { address: syntheticAddress(40), name: "Wrapped Ether", symbol: "WETH" },
      liquidity: { usd: 2500, base: 2, quote: 4 },
      volume: { h24: 900, h6: 200, h1: 30, m5: 2 },
      pairCreatedAt: 1700000010000,
    },
    {
      chainId: "ethereum",
      dexId: "sushiswap",
      pairAddress: PAIR_B,
      baseToken: { address: syntheticAddress(41), name: "Some Quote", symbol: "QUOTE" },
      quoteToken: { address: TOKEN_B, name: "Beta Token", symbol: "BETA" },
      liquidity: null,
      volume: { h24: 700, h6: 150, h1: 20, m5: 3 },
      pairCreatedAt: 1700000005000,
    },
    {
      chainId: "ethereum",
      dexId: "uniswap",
      pairAddress: syntheticAddress(34),
      baseToken: { address: TOKEN_C, name: "Gamma Token", symbol: "GAMMA" },
      quoteToken: { address: syntheticAddress(40), name: "Wrapped Ether", symbol: "WETH" },
      volume: { h24: 100, h6: 10, h1: 1, m5: 0 },
      pairCreatedAt: null,
    },
    {
      chainId: "ethereum",
      dexId: "uniswap",
      pairAddress: "0xbadpair",
      baseToken: { address: TOKEN_C, name: "Gamma Token", symbol: "GAMMA" },
      quoteToken: { address: syntheticAddress(40), name: "Wrapped Ether", symbol: "WETH" },
      pairCreatedAt: 1700000020000,
    },
  ]);
}

function ctx() {
  return { requestId: "test-market-1", deadlineMs: 1900000000000 };
}

function recordingTransport(seen: string[]): (url: string) => Promise<DexscreenerTransportResponse> {
  return async (url: string) => {
    seen.push(url);
    if (url.includes("/token-profiles/")) {
      return { status: 200, bodyText: profilesBody() };
    }
    if (url.includes("/token-boosts/")) {
      return { status: 200, bodyText: boostsBody() };
    }
    return { status: 200, bodyText: pairsBody() };
  };
}

describe("dexscreener market feed adapter", () => {
  test("serves newest-first items with checksummed addresses and money fields", async () => {
    const seen: string[] = [];
    const adapter = new DexscreenerMarketFeedAdapter({
      transport: recordingTransport(seen),
      now: () => 1700000100000,
    });
    const result = await adapter.fetchNewTokens({ chain: "ethereum" }, ctx());
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    // Token A wins with its newest pair; token B follows; token C has no
    // dated pair and stays out.
    expect(result.value.items).toHaveLength(2);
    const [first, second] = result.value.items;
    expect(first).toMatchObject({
      tokenAddress: checksum(TOKEN_A),
      symbol: "ALPHA",
      name: "Alpha Token",
      pairAddress: checksum(PAIR_A_NEW),
      dex: "uniswap",
      createdAt: 1700000010000,
      liquidityUsd: 2500,
      volume1hUsd: 30,
      volume24hUsd: 900,
    });
    // Token B lends its symbol and name from the quote side, with null
    // liquidity where the source reported none.
    expect(second).toMatchObject({
      tokenAddress: checksum(TOKEN_B),
      symbol: "BETA",
      name: "Beta Token",
      pairAddress: checksum(PAIR_B),
      dex: "sushiswap",
      createdAt: 1700000005000,
      liquidityUsd: null,
      volume1hUsd: 20,
      volume24hUsd: 700,
    });
    expect(first?.createdAt).toBeGreaterThan(second?.createdAt ?? 0);
  });

  test("filters chains, dedups discovery and batches pairs into one call", async () => {
    const seen: string[] = [];
    const adapter = new DexscreenerMarketFeedAdapter({
      transport: recordingTransport(seen),
      now: () => 1700000100000,
    });
    await adapter.fetchNewTokens({ chain: "ethereum" }, ctx());
    expect(seen).toHaveLength(3);
    expect(seen[0]).toBe(`${DEXSCREENER_BASE_URL}/token-profiles/latest/v1`);
    expect(seen[1]).toBe(`${DEXSCREENER_BASE_URL}/token-boosts/latest/v1`);
    // One batched pairs call in discovery order: A, B, then C.
    expect(seen[2]).toBe(
      `${DEXSCREENER_BASE_URL}/token-pairs/v1/ethereum/${TOKEN_A},${TOKEN_B},${TOKEN_C}`,
    );
    // One bad discovery address plus two unusable pair records skipped.
    expect(adapter.skippedItemCount()).toBe(3);
  });

  test("the token bucket paces refreshes and refills over time", async () => {
    let at = 1700000100000;
    const seen: string[] = [];
    const adapter = new DexscreenerMarketFeedAdapter({
      transport: recordingTransport(seen),
      now: () => at,
      burst: 3,
      callsPerSecond: 1,
    });
    const first = await adapter.fetchNewTokens({ chain: "ethereum" }, ctx());
    expect(first.ok).toBe(true);
    const paced = await adapter.fetchNewTokens({ chain: "ethereum" }, ctx());
    expect(paced.ok).toBe(false);
    if (!paced.ok) {
      expect(paced.error.kind).toBe("rate-limited");
      if (paced.error.kind === "rate-limited") {
        expect(paced.error.scope).toBe("local");
        expect(paced.error.retryAfterMs).toBeGreaterThan(0);
      }
    }
    at += 3000;
    const refilled = await adapter.fetchNewTokens({ chain: "ethereum" }, ctx());
    expect(refilled.ok).toBe(true);
  });

  test("provider 429 answers back off with zero further sends", async () => {
    const at = 1700000100000;
    let sends = 0;
    const adapter = new DexscreenerMarketFeedAdapter({
      transport: async () => {
        sends += 1;
        return { status: 429, bodyText: "rate limited" };
      },
      now: () => at,
    });
    const limited = await adapter.fetchNewTokens({ chain: "ethereum" }, ctx());
    expect(limited.ok).toBe(false);
    if (!limited.ok) {
      expect(limited.error.kind).toBe("rate-limited");
      if (limited.error.kind === "rate-limited") {
        expect(limited.error.scope).toBe("provider");
      }
    }
    const again = await adapter.fetchNewTokens({ chain: "ethereum" }, ctx());
    expect(again.ok).toBe(false);
    expect(sends).toBe(1);
  });

  test("timeouts, oversize and malformed replies stay typed", async () => {
    const hanging = new DexscreenerMarketFeedAdapter({
      transport: () => new Promise<DexscreenerTransportResponse>(() => {}),
      timeoutMs: 20,
      now: () => 1700000100000,
    });
    const timedOut = await hanging.fetchNewTokens({ chain: "ethereum" }, ctx());
    expect(timedOut.ok).toBe(false);
    if (!timedOut.ok) {
      expect(timedOut.error.kind).toBe("unavailable");
    }
    const capped = new DexscreenerMarketFeedAdapter({
      transport: recordingTransport([]),
      maxResponseBytes: 10,
      now: () => 1700000100000,
    });
    const oversize = await capped.fetchNewTokens({ chain: "ethereum" }, ctx());
    expect(oversize.ok).toBe(false);
    if (!oversize.ok) {
      expect(oversize.error.kind).toBe("invalid-response");
    }
    for (const bodyText of ["not json", '{"pairs":[]}']) {
      const malformed = new DexscreenerMarketFeedAdapter({
        transport: async () => ({ status: 200, bodyText }),
        now: () => 1700000100000,
      });
      const result = await malformed.fetchNewTokens({ chain: "ethereum" }, ctx());
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.kind).toBe("invalid-response");
      }
    }
  });

  test("non-allowlisted base URLs fail before any send", () => {
    expect(() => new DexscreenerMarketFeedAdapter({ baseUrl: "http://169.254.169.254/" })).toThrow();
    expect(() => new DexscreenerMarketFeedAdapter({ baseUrl: "https://other.example.invalid/" })).toThrow();
    expect(
      () =>
        new DexscreenerMarketFeedAdapter({
          baseUrl: "https://api.dexscreener.com/",
          transport: recordingTransport([]),
        }),
    ).not.toThrow();
  });

  test("off and unset providers stay not-configured with zero sends", async () => {
    for (const provider of [undefined, "off"] as const) {
      let sends = 0;
      const adapter = createMarketFeedAdapter(provider, {
        transport: async () => {
          sends += 1;
          return { status: 200, bodyText: "[]" };
        },
      });
      expect(adapter).toBeInstanceOf(NotConfiguredMarketFeedAdapter);
      const result = await adapter.fetchNewTokens({ chain: "ethereum" }, ctx());
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.kind).toBe("not-configured");
      }
      expect(sends).toBe(0);
    }
    const bound = createMarketFeedAdapter("dexscreener", { transport: recordingTransport([]) });
    expect(bound).toBeInstanceOf(DexscreenerMarketFeedAdapter);
  });
});
