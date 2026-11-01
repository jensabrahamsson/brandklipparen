import { describe, expect, test, vi } from "vitest";
import { renderToString } from "react-dom/server";
import { LiveTokensError, LiveTokensList } from "./LiveTokens.tsx";
import {
  fetchLiveTokens,
  feedStatusLabel,
  filterLiveEntries,
  formatAge,
  formatAgeCompact,
  isFeedStale,
  isSectionEngaged,
  mergeShown,
  nextLiveView,
  refreshShown,
  shortAddress,
  tokenCountLabel,
  unseenEntries,
  updatedAgoLabel,
} from "../lib/liveTokens.ts";
import { toChecksumAddress } from "../lib/checksumAddress.ts";
import { syntheticAddress } from "../lib/syntheticAddresses.ts";
import type { LiveTokenEntry, LiveTokensSnapshot } from "../lib/liveTokens.ts";

const NEW: LiveTokenEntry = {
  tokenAddress: syntheticAddress(2),
  symbol: "NEW",
  name: "New Token",
  pairAddress: syntheticAddress(10),
  dex: "Uniswap V2",
  block: 21600002,
  createdAt: 1700000000000,
  blockTimestampMs: 1700000000000 - 45 * 1000,
  ageSeconds: 45,
  initialLiquidityWeth: "1.5",
  state: "done",
  riskBand: "Low",
  score: 12,
};

const PENDING: LiveTokenEntry = {
  tokenAddress: syntheticAddress(3),
  symbol: null,
  name: null,
  pairAddress: syntheticAddress(11),
  dex: "Uniswap V3",
  feeTier: 3000,
  block: 21600001,
  createdAt: 1699999990000,
  blockTimestampMs: 1699999990000 - 3700 * 1000,
  ageSeconds: 3700,
  initialLiquidityWeth: null,
  state: "analyzing",
};

const CANT_TELL: LiveTokenEntry = {
  tokenAddress: syntheticAddress(4),
  symbol: null,
  name: null,
  pairAddress: syntheticAddress(12),
  dex: "Uniswap V2",
  block: 21600000,
  createdAt: 1699999900000,
  blockTimestampMs: null,
  ageSeconds: null,
  initialLiquidityWeth: null,
  state: "cant-tell",
  reason: "no contract code at the pinned block",
};

function snapshot(items: readonly LiveTokenEntry[]): LiveTokensSnapshot {
  return { source: "etherscan", status: "live", updatedAt: 1700000000000, items };
}

// Rendered text without markup: grouped address chunks wrap by group in
// the markup but read as the full address, so text assertions strip tags.
function renderedText(html: string): string {
  return html.replace(/<[^>]+>/g, "");
}

const NO_MARKET = new Map<never, never>();

describe("live tokens list", () => {
  test("rows render newest first with symbol, age, pair and liquidity", () => {
    const html = renderToString(<LiveTokensList snapshot={snapshot([NEW, PENDING])} marketByToken={NO_MARKET} />);
    const firstRow = html.indexOf(NEW.tokenAddress);
    const secondRow = html.indexOf(PENDING.tokenAddress);
    expect(firstRow).toBeGreaterThan(-1);
    expect(secondRow).toBeGreaterThan(firstRow);
    expect(html).toContain("NEW");
    expect(html).toContain("just now");
    expect(html).toContain("Uniswap V2");
    expect(html).toContain("1.5 WETH");
    expect(html).toContain("Uniswap V3");
    expect(html).toContain("0.3%");
    expect(html).toContain(">1h ago<");
    expect(html).toContain("analyzing…");
    expect(html).toContain("can&#x27;t tell");
  });

  test("duplicate symbols stay distinguishable by fee tier", () => {
    const first = { ...PENDING, symbol: "NEW" };
    const second = { ...PENDING, symbol: "NEW", pairAddress: syntheticAddress(30), feeTier: 10000 };
    const html = renderToString(<LiveTokensList snapshot={snapshot([first, second])} marketByToken={NO_MARKET} />);
    expect(html).toContain("0.3%");
    expect(html).toContain("1%");
  });

  test("queued rows read analyzing until the queue reaches them", () => {
    const queued: LiveTokenEntry = { ...PENDING, state: "queued", reason: undefined };
    const html = renderToString(<LiveTokensList snapshot={snapshot([queued])} marketByToken={NO_MARKET} />);
    expect(html).toContain("analyzing…");
    expect(html).not.toContain('data-testid="risk-badge"');
  });

  test("done rows carry the risk badge while missing data reads calm", () => {
    const html = renderToString(<LiveTokensList snapshot={snapshot([NEW, CANT_TELL])} marketByToken={NO_MARKET} />);
    expect(html).toContain('data-testid="risk-badge"');
    expect(html).toContain("can&#x27;t tell");
    expect(html).toContain(">unknown<");
    expect(html).not.toContain(">-<");
  });

  test("unknown chain age reads as a labelled unknown with the reason, never a bare dash", () => {
    const html = renderToString(<LiveTokensList snapshot={snapshot([CANT_TELL])} marketByToken={NO_MARKET} />);
    expect(html).toContain(">unknown<");
    expect(html).not.toContain(">-<");
    expect(html).toContain("Pair creation time not reported");
    expect(html).not.toContain('<span class="live-new">new</span>');
  });

  test("s124_filters_name_both_bands_and_count_uses_grammar", () => {
    const html = renderToString(<LiveTokensList snapshot={snapshot([NEW, PENDING])} lastPollAt={1700000006000} marketByToken={NO_MARKET} />);
    expect(html).toContain("Elevated &amp; high");
    expect(html).toContain(">Low<");
    expect(html).not.toContain("High risk");
    expect(html).not.toContain("Low risk");
    expect(renderToString(<LiveTokensList snapshot={snapshot([NEW])} marketByToken={NO_MARKET} />)).toContain("1 new token");
    expect(html).toContain("2 new tokens");
    expect(html).toMatch(/Updated \d+ s ago/);
  });

  test("s124_filter_entries_match_labels_without_contradiction", () => {
    const elevated: LiveTokenEntry = { ...NEW, riskBand: "Elevated" };
    const high: LiveTokenEntry = { ...NEW, riskBand: "High", pairAddress: syntheticAddress(20) };
    const low: LiveTokenEntry = { ...NEW, riskBand: "Low", pairAddress: syntheticAddress(21) };
    const items = [elevated, high, low];
    expect(filterLiveEntries(items, "Elevated & high").map((entry) => entry.pairAddress)).toEqual([
      elevated.pairAddress,
      high.pairAddress,
    ]);
    expect(filterLiveEntries(items, "Low").map((entry) => entry.pairAddress)).toEqual([low.pairAddress]);
    expect(filterLiveEntries(items, "All")).toHaveLength(3);
    expect(tokenCountLabel(1)).toBe("1 new token");
    expect(tokenCountLabel(2)).toBe("2 new tokens");
    expect(updatedAgoLabel(1700000000000, 1700000006000)).toBe("Updated 6 s ago");
  });

  test("s124_buffered_entries_never_repeat_or_reorder", () => {
    const first = unseenEntries([NEW], [PENDING, NEW], []);
    expect(first.map((entry) => entry.pairAddress)).toEqual([PENDING.pairAddress]);
    const second = unseenEntries([NEW], [PENDING, NEW], first);
    expect(second).toHaveLength(1);
    const shown = mergeShown([NEW], second);
    expect(shown.map((entry) => entry.pairAddress)).toEqual([PENDING.pairAddress, NEW.pairAddress]);
  });

  test("token links open the token page and rows keep stable keys", () => {
    const html = renderToString(<LiveTokensList snapshot={snapshot([NEW])} marketByToken={NO_MARKET} />);
    expect(html).toContain(`href="#/token/${NEW.tokenAddress}"`);
    // Grouped chunks wrap by group; the rendered text stays the full form.
    expect(renderedText(html)).toContain(toChecksumAddress(NEW.tokenAddress));
    expect(html).toContain('class="feed-row');
  });

  test("s134_full_addresses_render_with_copy_and_no_short_form", () => {
    const html = renderToString(<LiveTokensList snapshot={snapshot([NEW, PENDING])} marketByToken={NO_MARKET} />);
    expect(renderedText(html)).toContain(toChecksumAddress(NEW.tokenAddress));
    expect(renderedText(html)).toContain(toChecksumAddress(PENDING.tokenAddress));
    expect(html).toContain('aria-label="Copy contract address"');
    expect(html).not.toContain('aria-label="Copy pair address"');
  });

  test("r2-4_copy_controls_ride_line_1_never_under_the_address", () => {
    const html = renderToString(<LiveTokensList snapshot={snapshot([NEW])} marketByToken={NO_MARKET} />);
    // The copy control renders before the address line opens.
    const copyAt = html.indexOf('aria-label="Copy contract address"');
    const line3At = html.indexOf("feed-line3");
    expect(copyAt).toBeGreaterThanOrEqual(0);
    expect(line3At).toBeGreaterThan(copyAt);
    // Line 3 carries the grouped address and no button of its own.
    const line3 = (html.split("feed-line3")[1] ?? "").split("</div>")[0] ?? "";
    expect(line3).toContain(toChecksumAddress(NEW.tokenAddress).slice(0, 6));
    expect(line3).not.toContain("<button");
  });

  test("s36_live_list_shows_checksummed_addresses_but_routes_on_raw", () => {
    const rawToken = "0x5ab1e0000000000000000000000000000000c001";
    const rawPair = "0x5ab1e0000000000000000000000000000000c0cc";
    const token = "0x5Ab1E0000000000000000000000000000000c001";
    const pair = "0x5Ab1E0000000000000000000000000000000C0Cc";
    expect(toChecksumAddress(rawToken)).toBe(token);
    expect(toChecksumAddress(rawPair)).toBe(pair);
    const entry: LiveTokenEntry = {
      ...NEW,
      tokenAddress: rawToken,
      symbol: null,
      name: null,
      pairAddress: rawPair,
    };
    const html = renderToString(<LiveTokensList snapshot={snapshot([entry])} marketByToken={NO_MARKET} />);
    // Feed rows display the checksummed token address only.
    expect(renderedText(html)).toContain(token);
    expect(renderedText(html)).not.toContain(rawToken);
    // Routing keys stay raw: links still target the original address.
    expect(html).toContain(`href="#/token/${rawToken}"`);
    expect(html).not.toContain(`href="#/token/${token}"`);
  });

  test("the new marker is static text with no animation hooks", () => {
    const html = renderToString(<LiveTokensList snapshot={snapshot([NEW])} marketByToken={NO_MARKET} />);
    expect(html).toContain('<span class="live-new">new</span>');
    // The marker element itself carries no animation hook: it renders
    // uppercase through CSS only. (Section-level one-shot fades live on
    // ancestor sections, never on the marker.)
    const marker = html.match(/<span class="live-new"[^>]*>.*?<\/span>/)?.[0] ?? "";
    expect(marker).toBe('<span class="live-new">new</span>');
    expect(marker).not.toMatch(/animat|fade|slide|transition|keyframes|blink|flash/i);
  });

  test("the count line is the single polite live region", () => {
    const html = renderToString(<LiveTokensList snapshot={snapshot([NEW, PENDING])} marketByToken={NO_MARKET} />);
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain("2 new tokens");
    // Feed rows replaced the table: no table markup at all.
    expect(html).not.toContain("<table");
    expect(html).not.toContain("<ulARIA");
    expect(html).toContain('class="feed-rows"');
  });

  test("dx1_rows_page_at_10_and_keep_the_total_in_the_label", () => {
    const many = Array.from({ length: 30 }, (_, index) =>
      index === 0 ? NEW : { ...PENDING, pairAddress: syntheticAddress(100 + index) },
    );
    const html = renderToString(<LiveTokensList snapshot={snapshot(many)} marketByToken={NO_MARKET} />);
    expect(renderedText(html)).toContain("10 of 30 new tokens");
    expect(renderedText(html).replace(/<!-- -->/g, "")).toContain("Show 10 more");
    expect(html.match(/class="feed-row[ "]/g)).toHaveLength(10);
  });

  test("empty and not-configured states read plainly", () => {
    expect(renderToString(<LiveTokensList snapshot={snapshot([])} marketByToken={NO_MARKET} />)).toContain("Waiting for new pairs…");
    const off = renderToString(
      <LiveTokensList
        snapshot={{ source: "none", status: "not-configured", updatedAt: 0, items: [] }}
        marketByToken={NO_MARKET}
      />,
    );
    expect(off).toContain("New tokens are unavailable");
    expect(off).not.toContain("ETHERSCAN_API_KEY");
    expect(off).not.toContain(".env");
  });
});

describe("live tokens client", () => {
  test("age reads as a human phrase from feed data, unknown stays labelled", () => {
    expect(formatAge(5)).toBe("just now");
    expect(formatAge(125)).toBe("2 min ago");
    expect(formatAge(3700)).toBe("1 h ago");
    expect(formatAge(90000)).toBe("1 d ago");
    expect(formatAge(null)).toBe("unknown");
  });

  test("dx1_compact_age_reads_whole_units_for_feed_rows", () => {
    expect(formatAgeCompact(5)).toBe("just now");
    expect(formatAgeCompact(125)).toBe("2m ago");
    expect(formatAgeCompact(3700)).toBe("1h ago");
    expect(formatAgeCompact(7200)).toBe("2h ago");
    expect(formatAgeCompact(90000)).toBe("1d ago");
    expect(formatAgeCompact(null)).toBe("unknown");
    expect(formatAgeCompact(Number.NaN)).toBe("unknown");
  });

  test("s132_updated_label_reads_plainly_and_flags_a_stale_feed", () => {
    const base = 1700000000000;
    expect(updatedAgoLabel(base, base + 3_000)).toBe("Updated just now");
    expect(updatedAgoLabel(base, base + 12_000)).toBe("Updated 12 s ago");
    expect(updatedAgoLabel(base, base + 180_000)).toBe("Updated 3 min ago");
    expect(updatedAgoLabel(base, base - 5_000)).toBe("Updated just now");
    expect(isFeedStale(base, base + 60_000)).toBe(false);
    expect(isFeedStale(base, base + 119_000)).toBe(false);
    expect(isFeedStale(base, base + 121_000)).toBe(true);
    expect(feedStatusLabel(base, base + 12_000)).toBe("Updated 12 s ago");
    expect(feedStatusLabel(base, base + 240_000)).toBe("Feed paused, last update 4 min ago");
    const staleHtml = renderToString(
      <LiveTokensList snapshot={snapshot([NEW])} lastPollAt={base + 300_000} marketByToken={NO_MARKET} />,
    );
    expect(staleHtml).toContain("Feed paused, last update 5 min ago");
    const freshHtml = renderToString(<LiveTokensList snapshot={snapshot([NEW])} lastPollAt={base + 12_000} marketByToken={NO_MARKET} />);
    expect(freshHtml).toContain("Updated 12 s ago");
  });

  test("short addresses keep head and tail", () => {
    expect(shortAddress(syntheticAddress(2))).toBe(
      `${syntheticAddress(2).slice(0, 6)}…${syntheticAddress(2).slice(-4)}`,
    );
    expect(shortAddress("short")).toBe("short");
  });

  test("fetch returns the snapshot and throws typed errors", async () => {
    const body = snapshot([NEW]);
    const fetchMock = vi.fn(async (): Promise<Response> => new Response(JSON.stringify(body), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    try {
      const seen = await fetchLiveTokens("demo-key");
      expect(seen.source).toBe("etherscan");
      expect(seen.items).toHaveLength(1);
      expect(fetchMock).toHaveBeenCalledOnce();
    } finally {
      vi.unstubAllGlobals();
    }
    const failing = vi.fn(
      async (): Promise<Response> =>
        new Response(JSON.stringify({ code: "invalid-api-key", message: "Bad key." }), { status: 401 }),
    );
    vi.stubGlobal("fetch", failing);
    try {
      await expect(fetchLiveTokens("wrong")).rejects.toMatchObject({ status: 401, code: "invalid-api-key" });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  test("a load failure is a polite status, not an alert, so it never competes with form errors", () => {
    const html = renderToString(<LiveTokensError message="Could not load new tokens. Retrying…" />);
    expect(html).toContain('role="status"');
    expect(html).not.toContain('role="alert"');
    expect(html).toContain("Could not load new tokens. Retrying…");
  });
});

describe("c14 feed freeze", () => {
  function idleRoot(): { contains: (node: Node | null) => boolean; matches: (selector: string) => boolean } {
    return { contains: () => false, matches: () => false };
  }

  test("scroll position alone never counts as engaged", () => {
    vi.stubGlobal("window", { scrollY: 480 });
    try {
      expect(isSectionEngaged(idleRoot())).toBe(false);
      expect(isSectionEngaged(null)).toBe(false);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  test("focus or hover inside the section counts as engaged", () => {
    const focused = {} as unknown as Node;
    vi.stubGlobal("document", { activeElement: focused });
    try {
      expect(isSectionEngaged({ contains: (node) => node === focused, matches: () => false })).toBe(true);
      expect(isSectionEngaged({ contains: () => false, matches: () => true })).toBe(true);
      expect(isSectionEngaged({ contains: () => false, matches: () => false })).toBe(false);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  test("an engaged poll merges updates into shown rows and buffers only unseen rows", () => {
    vi.stubGlobal("window", { scrollY: 480 });
    try {
      const shown: LiveTokenEntry = { ...PENDING, state: "analyzing", score: undefined };
      const current = { snapshot: snapshot([shown]), buffered: [] as LiveTokenEntry[] };
      const resolved: LiveTokenEntry = { ...PENDING, state: "done", riskBand: "Low", score: 12 };
      const fresh: LiveTokenEntry = { ...NEW, pairAddress: syntheticAddress(40) };
      const next = snapshot([resolved, fresh]);
      const view = nextLiveView(current, { ...next, updatedAt: 1700000060000 }, true);
      // The shown row resolves in place and keeps its position.
      expect(view.snapshot.items.map((entry) => entry.pairAddress)).toEqual([PENDING.pairAddress]);
      expect(view.snapshot.items[0]?.state).toBe("done");
      expect(view.snapshot.items[0]?.score).toBe(12);
      // The header timestamp advances, so the feed never reads paused.
      expect(view.snapshot.updatedAt).toBe(1700000060000);
      // Only the unseen row waits in the buffer.
      expect(view.buffered.map((entry) => entry.pairAddress)).toEqual([fresh.pairAddress]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  test("a disengaged poll replaces the snapshot and drops the buffer", () => {
    const current = { snapshot: snapshot([NEW]), buffered: [PENDING] };
    const view = nextLiveView(current, snapshot([CANT_TELL]), false);
    expect(view.snapshot.items.map((entry) => entry.pairAddress)).toEqual([CANT_TELL.pairAddress]);
    expect(view.buffered).toEqual([]);
    expect(nextLiveView(null, snapshot([NEW]), true).snapshot.items).toHaveLength(1);
  });

  test("refreshShown keeps shown order and keeps rows missing from the poll", () => {
    const incoming: LiveTokenEntry = { ...PENDING, state: "done", riskBand: "High", score: 78 };
    expect(refreshShown([PENDING, NEW], [incoming]).map((entry) => entry.pairAddress)).toEqual([
      PENDING.pairAddress,
      NEW.pairAddress,
    ]);
    expect(refreshShown([PENDING, NEW], [incoming])[0]).toEqual(incoming);
    expect(refreshShown([PENDING, NEW], [incoming])[1]).toEqual(NEW);
    expect(refreshShown([NEW], [])).toEqual([NEW]);
  });
});
