// DexScreener market listing client (DX-1): chain filtering, null
// mapping, the 1 h to 24 h volume switch, compact money formatting and
// the owner-power chip states. Synthetic addresses only; no network.
import { describe, expect, test, vi } from "vitest";
import {
  MARKET_VOLUME_SWITCH_MS,
  fetchMarketNew,
  formatPriceChange,
  formatUsdCompact,
  marketChip,
  marketCountLabel,
  marketShownLabel,
  marketVolumeFor,
  mergeMarketShown,
  parseMarketItem,
  parseMarketSnapshot,
  unseenMarketItems,
  type MarketItem,
} from "./market.ts";
import { syntheticAddress } from "./syntheticAddresses.ts";

const BASE = 1700000000000;

function rawItem(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    tokenAddress: syntheticAddress(71).toLowerCase(),
    symbol: "SYN",
    name: "Synthetic Token",
    pairAddress: syntheticAddress(72).toLowerCase(),
    dex: "uniswap",
    createdAt: BASE,
    liquidityUsd: 48200,
    volume1hUsd: 12400,
    volume24hUsd: 96000,
    priceChange24hPct: 3.24,
    ...overrides,
  };
}

function validItem(overrides: Partial<MarketItem> = {}): MarketItem {
  const parsed = parseMarketItem(
    rawItem({
      tokenAddress: syntheticAddress(73).toLowerCase(),
      pairAddress: syntheticAddress(74).toLowerCase(),
      ...overrides,
    }),
  );
  if (parsed === null) {
    throw new Error("synthetic item must parse");
  }
  return parsed;
}

describe("market listing client", () => {
  test("dx1_drops_non_ethereum_items_and_keeps_valid_rows", () => {
    expect(parseMarketItem(rawItem({ chainId: "solana" }))).toBeNull();
    expect(parseMarketItem(rawItem({ chainId: "ethereum" }))).not.toBeNull();
    // Absent chain ids stay: the server already serves ethereum only.
    expect(parseMarketItem(rawItem())).not.toBeNull();
    expect(parseMarketItem(rawItem({ tokenAddress: "0xnotanaddress" }))).toBeNull();
    expect(parseMarketItem(rawItem({ dex: "" }))).toBeNull();
    expect(parseMarketItem(rawItem({ createdAt: -1 }))).toBeNull();
  });

  test("dx1_nulls_map_to_cant_tell_values_never_zero", () => {
    const parsed = parseMarketItem(
      rawItem({ liquidityUsd: null, volume1hUsd: null, volume24hUsd: null, priceChange24hPct: null }),
    );
    expect(parsed).not.toBeNull();
    expect(parsed?.liquidityUsd).toBeNull();
    expect(parsed?.volume1hUsd).toBeNull();
    expect(parsed?.volume24hUsd).toBeNull();
    expect(parsed?.priceChange24hPct).toBeNull();
    expect(formatUsdCompact(null)).toBeNull();
    expect(formatPriceChange(null)).toBeNull();
    // A zero balance is data, not a missing value.
    expect(formatUsdCompact(0)).toBe("$0");
  });

  test("dx1_volume_switches_from_1h_to_24h_at_a_day_old", () => {
    const young = validItem({ createdAt: BASE });
    expect(marketVolumeFor(young, BASE + 12 * 60 * 60 * 1000)).toEqual({ label: "Vol 1h", value: 12400 });
    const old = validItem({ createdAt: BASE });
    expect(marketVolumeFor(old, BASE + MARKET_VOLUME_SWITCH_MS)).toEqual({ label: "Vol 24h", value: 96000 });
    // A missing window reads as a missing value, never the other window.
    const missing = validItem({ volume24hUsd: null, createdAt: BASE });
    expect(marketVolumeFor(missing, BASE + MARKET_VOLUME_SWITCH_MS + 1000)).toEqual({
      label: "Vol 24h",
      value: null,
    });
  });

  test("dx1_compact_money_and_signed_moves", () => {
    expect(formatUsdCompact(48200)).toBe("$48.2k");
    expect(formatUsdCompact(1100000)).toBe("$1.1M");
    expect(formatUsdCompact(2500000000)).toBe("$2.5B");
    expect(formatUsdCompact(999)).toBe("$999");
    expect(formatPriceChange(3.24)).toBe("+3.2%");
    expect(formatPriceChange(-1.04)).toBe("-1%");
  });

  test("dx1_chip_follows_analysis_then_recent_then_unscanned", () => {
    const analysed = validItem({ analysis: { score: 45, powersFound: 3, powersExtended: 1 } });
    expect(marketChip(analysed, new Map())).toEqual({ kind: "powers", found: 3, extended: 1 });
    const analysedExtendedOnly = validItem({ analysis: { score: 19, powersFound: 0, powersExtended: 2 } });
    expect(marketChip(analysedExtendedOnly, new Map())).toEqual({ kind: "powers", found: 0, extended: 2 });
    const analysedNone = validItem({ analysis: { score: 12, powersFound: 0, powersExtended: 0 } });
    expect(marketChip(analysedNone, new Map())).toEqual({ kind: "none" });
    const plain = validItem();
    expect(marketChip(plain, new Map())).toEqual({ kind: "unscanned" });
    expect(
      marketChip(plain, new Map([[plain.tokenAddress.toLowerCase(), { score: 19, word: "Low" }]])),
    ).toEqual({ kind: "recent", score: 19, word: "Low" });
    // An attached analysis wins over a stale recent record.
    expect(
      marketChip(analysed, new Map([[analysed.tokenAddress.toLowerCase(), { score: 19, word: "Low" }]])),
    ).toEqual({ kind: "powers", found: 3, extended: 1 });
  });

  test("dx1_snapshot_sorts_newest_first_and_labels_counts", () => {
    const older = rawItem({ tokenAddress: syntheticAddress(75).toLowerCase(), createdAt: BASE });
    const newer = rawItem({ tokenAddress: syntheticAddress(76).toLowerCase(), createdAt: BASE + 60000 });
    const dropped = rawItem({ tokenAddress: syntheticAddress(77).toLowerCase(), chainId: "solana" });
    const parsed = parseMarketSnapshot({ updatedAt: BASE, items: [older, newer, dropped] });
    expect(parsed?.items.map((entry) => entry.tokenAddress)).toEqual([
      (newer["tokenAddress"] as string),
      (older["tokenAddress"] as string),
    ]);
    expect(parseMarketSnapshot({ updatedAt: BASE, items: "nope" })).toBeNull();
    expect(marketCountLabel(1)).toBe("1 new token");
    expect(marketCountLabel(2)).toBe("2 new tokens");
    expect(marketShownLabel(2, 2)).toBe("2 new tokens");
    expect(marketShownLabel(25, 200)).toBe("25 of 200 new tokens");
  });

  test("dx1_buffered_market_inserts_never_repeat", () => {
    const first = validItem({ tokenAddress: syntheticAddress(78).toLowerCase() });
    const second = validItem({ tokenAddress: syntheticAddress(79).toLowerCase() });
    const fresh = unseenMarketItems([first], [second, first], []);
    expect(fresh.map((entry) => entry.tokenAddress)).toEqual([second.tokenAddress]);
    const shown = mergeMarketShown([first], fresh);
    expect(shown.map((entry) => entry.tokenAddress)).toEqual([second.tokenAddress, first.tokenAddress]);
  });

  test("dx1_fetch_returns_the_snapshot_and_maps_not_configured", async () => {
    const body = { updatedAt: BASE, items: [rawItem()] };
    const fetchMock = vi.fn(async (): Promise<Response> => new Response(JSON.stringify(body), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    try {
      const seen = await fetchMarketNew("demo-key");
      expect(seen.status).toBe("live");
      expect(seen.items).toHaveLength(1);
      expect(fetchMock).toHaveBeenCalledWith("/v1/market-new?chain=ethereum", {
        headers: { "x-api-key": "demo-key" },
      });
    } finally {
      vi.unstubAllGlobals();
    }
    const off = vi.fn(
      async (): Promise<Response> =>
        new Response(JSON.stringify({ code: "market-not-configured", message: "Off." }), { status: 501 }),
    );
    vi.stubGlobal("fetch", off);
    try {
      const snapshot = await fetchMarketNew(null);
      expect(snapshot.status).toBe("not-configured");
      expect(snapshot.items).toEqual([]);
    } finally {
      vi.unstubAllGlobals();
    }
    const down = vi.fn(
      async (): Promise<Response> =>
        new Response(JSON.stringify({ code: "upstream-unavailable", message: "Down." }), { status: 502 }),
    );
    vi.stubGlobal("fetch", down);
    try {
      await expect(fetchMarketNew(null)).rejects.toMatchObject({ status: 502 });
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
