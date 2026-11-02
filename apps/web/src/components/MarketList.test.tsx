// DexScreener market rows (DX-1, W-13, U-12): owner-power chips instead
// of scores (the score survives only for recent visits), compact money,
// "can't tell" for missing market data, paging with the total in the
// label, and a 44 px copy per full address. Synthetic addresses only; no network
// (MarketListRows renders from a snapshot).
import { describe, expect, test } from "vitest";
import { renderToString } from "react-dom/server";
import { MarketListRows } from "./MarketList.tsx";
import { marketAgeSeconds, marketStatusLabel, type MarketItem } from "../lib/market.ts";
import { syntheticAddress } from "../lib/syntheticAddresses.ts";

const BASE = 1700000000000;

function item(overrides: Partial<MarketItem> = {}): MarketItem {
  return {
    tokenAddress: syntheticAddress(81).toLowerCase(),
    symbol: "SYN",
    name: "Synthetic Token",
    pairAddress: syntheticAddress(82).toLowerCase(),
    dex: "uniswap",
    createdAt: BASE,
    liquidityUsd: 48200,
    volume1hUsd: 12400,
    volume24hUsd: 96000,
    priceChange24hPct: 3.24,
    ...overrides,
  };
}

const EMPTY_MAP = new Map<string, { score: number; word: string }>();
const EMPTY_SET = new Set<string>();

function rows(items: readonly MarketItem[]): string {
  return renderToString(
    <MarketListRows
      snapshot={{ status: "live", updatedAt: BASE, items }}
      recentByToken={EMPTY_MAP}
      liveTokens={EMPTY_SET}
    />,
  );
}

function stripped(html: string): string {
  return html.replace(/<[^>]+>/g, "").replace(/&#x27;|&apos;/g, "'");
}

describe("market list rows", () => {
  test("dx1_rows_show_symbol_age_chip_and_full_address", () => {
    const html = rows([
      item({ analysis: { score: 45, powersFound: 3, powersExtended: 1 } }),
    ]);
    const text = stripped(html);
    expect(text).toContain("SYN");
    // U-12 (P9): the owner-power chip replaces the score, so analysed
    // rows carry no risk badge. The extended count reads "+N" with its
    // meaning in the tooltip.
    expect(text).toContain("3 powers +1");
    expect(text).not.toContain("1 not in score");
    expect(html).toContain("not in score");
    expect(html).not.toContain('data-testid="risk-badge"');
    expect(text).toContain(item().tokenAddress);
    expect(html).toContain('aria-label="Copy contract address"');
    expect(html).toContain('class="feed-row');
  });

  test("dx1_unscanned_rows_read_not_scanned_with_no_score", () => {
    const html = rows([item()]);
    expect(stripped(html)).toContain("Not scanned");
    expect(html).not.toContain('data-testid="risk-badge"');
  });

  test("dx1_recent_visits_render_the_score_without_a_powers_claim", () => {
    const entry = item();
    const html = renderToString(
      <MarketListRows
        snapshot={{ status: "live", updatedAt: BASE, items: [entry] }}
        recentByToken={new Map([[entry.tokenAddress, { score: 19, word: "Low" }]])}
        liveTokens={EMPTY_SET}
      />,
    );
    expect(html).toContain('data-testid="risk-badge"');
    expect(stripped(html)).not.toContain("owner powers");
  });

  test("dx1_missing_market_data_reads_cant_tell", () => {
    // U-12: line 2 carries DEX, liquidity and volume only; the price
    // move is dropped as newborn-pair noise. Missing money reads as
    // "can't tell", never a dash or a zero.
    const html = rows([item({ liquidityUsd: null, volume1hUsd: null, volume24hUsd: null, priceChange24hPct: null })]);
    expect(stripped(html)).toContain("can't tell");
    expect(stripped(html)).not.toContain("—");
  });

  test("dx1_also_in_new_pairs_marks_shared_tokens", () => {
    const entry = item();
    const html = renderToString(
      <MarketListRows
        snapshot={{ status: "live", updatedAt: BASE, items: [entry] }}
        recentByToken={EMPTY_MAP}
        liveTokens={new Set([entry.tokenAddress])}
      />,
    );
    expect(stripped(html)).toContain("Also in New pairs");
  });

  test("dx1_volume_switches_to_24h_for_day_old_pairs", () => {
    const entry = item({ createdAt: BASE - 25 * 60 * 60 * 1000 });
    const html = renderToString(
      <MarketListRows
        snapshot={{ status: "live", updatedAt: BASE, items: [entry] }}
        recentByToken={EMPTY_MAP}
        liveTokens={EMPTY_SET}
      />,
    );
    expect(stripped(html)).toContain("Vol 24h");
    expect(stripped(html)).not.toContain("Vol 1h");
  });

  test("dx1_rows_page_at_10_with_the_total_in_the_label", () => {
    const many = Array.from({ length: 30 }, (_, index) =>
      item({ tokenAddress: syntheticAddress(200 + index).toLowerCase() }),
    );
    const html = renderToString(
      <MarketListRows
        snapshot={{ status: "live", updatedAt: BASE, items: many }}
        recentByToken={EMPTY_MAP}
        liveTokens={EMPTY_SET}
      />,
    );
    expect(stripped(html)).toContain("10 of 30 new tokens");
    expect(stripped(html)).toContain("Show 10 more");
    expect(html.match(/class="feed-row[ "]/g)).toHaveLength(10);
  });

  test("dx1_market_staleness_reads_stale_after_five_minutes", () => {
    expect(marketAgeSeconds(BASE, BASE + 60_000)).toBe(60);
    expect(marketAgeSeconds(-1, BASE)).toBeNull();
    expect(marketStatusLabel(BASE, BASE + 3_000)).toBe("Updated just now");
    expect(marketStatusLabel(BASE, BASE + 60_000)).toBe("Updated 1 min ago");
    expect(marketStatusLabel(BASE, BASE + 360_000)).toBe("Stale · updated 6 min ago");
  });
});
