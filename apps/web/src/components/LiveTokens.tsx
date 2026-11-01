// Live new-tokens list: a calm feed of fresh Uniswap V2/V3 pairs,
// newest first, polled every ~10 s. Rows never jump: while the reader is
// scrolled or focused inside the list, new rows wait in a buffer behind
// an "N new tokens · Show" pill instead of pushing the rows down.
// The count line is the single polite live region; the list itself is
// not one, so screen readers hear the count, not every row.
// Rows are the shared FeedRow (DX-1): symbol, compact age, score, DEX,
// WETH liquidity, DexScreener market enrichment (W-13, display only),
// then the full token address with copy. The list shows 10 rows plus
// "Show 10 more"; the total stays in the label (W-12).
import { useEffect, useRef, useState, type CSSProperties, type JSX, type RefObject } from "react";
import { riskBand } from "../lib/risk.ts";
import { RiskBadge } from "./RiskBadge.tsx";
import { FeedRow } from "./FeedRow.tsx";
import { Pictogram } from "./Pictogram.tsx";
import {
  fetchLiveTokens,
  feedStatusLabel,
  filterLiveEntries,
  formatAgeCompact,
  mergeShown,
  tokenCountLabel,
  unseenEntries,
} from "../lib/liveTokens.ts";
import { formatUsdCompact, marketVolumeFor, type MarketItem } from "../lib/market.ts";
import type { LiveFilter, LiveTokenEntry, LiveTokensSnapshot } from "../lib/liveTokens.ts";

// Live list page size (W-12): 10 rows plus "Show 10 more", so the start
// page stays under its height budget with both feeds full.
export const LIVE_PAGE_SIZE = 10;

const FILTERS = ["All", "Elevated & high", "Low"] as const;

type Filter = (typeof FILTERS)[number];

function filterToEntries(items: readonly LiveTokenEntry[], filter: Filter): readonly LiveTokenEntry[] {
  return filterLiveEntries(items, filter as LiveFilter);
}

// Age reads as a compact feed stamp from the feed's own chain timestamp;
// the block number rides in the tooltip as provenance. An unknown chain
// age reads as a quiet labelled "unknown" with the reason, never a bare
// "-" that looks like a bug.
function ageProps(entry: LiveTokenEntry): { label: string; dateTime: string | null; title: string } {
  const label = formatAgeCompact(entry.ageSeconds);
  if (label !== "unknown") {
    const stamp = entry.blockTimestampMs;
    return {
      label,
      dateTime: stamp === null ? null : new Date(stamp).toISOString(),
      title: `Block ${entry.block}`,
    };
  }
  return {
    label: "unknown",
    dateTime: null,
    title: `Pair creation time not reported by the feed (block ${entry.block})`,
  };
}

function bandClass(entry: LiveTokenEntry): string {
  if (entry.state === "done" && typeof entry.score === "number") {
    const word = riskBand(entry.score).word;
    return word === "Low" ? "band-low" : word === "Elevated" ? "band-elevated" : "band-high";
  }
  if (entry.riskBand === "Low") {
    return "band-low";
  }
  if (entry.riskBand === "Elevated") {
    return "band-elevated";
  }
  return "band-high";
}

function riskCell(entry: LiveTokenEntry): JSX.Element {
  if (entry.state === "done" && typeof entry.score === "number") {
    return (
      <span className={`risk ${bandClass(entry)}`}>
        <RiskBadge score={entry.score} />
      </span>
    );
  }
  if (entry.state === "queued" || entry.state === "analyzing") {
    // Terminal analyzing state: uppercase through CSS, block cursor
    // blinking at 1 Hz. The label stays polite for screen readers.
    return (
      <span className="pending" aria-label="Analyzing">
        analyzing…<b aria-hidden="true">▌</b>
      </span>
    );
  }
  if (entry.state === "cant-tell") {
    return (
      <span className="cantword" title={entry.reason ?? "missing data"}>
        can&apos;t tell
      </span>
    );
  }
  if (entry.state === "skipped") {
    return <span className="muted">skipped</span>;
  }
  return <span className="muted">{entry.reason ?? "error"}</span>;
}

// DexScreener market enrichment for one on-chain row (W-13): liquidity
// USD, 24 h volume and price change when the market listing holds this
// token, clearly labelled and display only. Missing data reads "—".
function marketSegment(
  entry: LiveTokenEntry,
  marketByToken: ReadonlyMap<string, MarketItem>,
): JSX.Element {
  const market = marketByToken.get(entry.tokenAddress.toLowerCase());
  const title = "Market data from DexScreener, not part of the score.";
  if (market === undefined) {
    return (
      <span className="meta-item" title={title}>
        <span className="feed-pic" aria-hidden="true">
          <Pictogram name="market" size={16} />
        </span>{" "}
        Market —
      </span>
    );
  }
  const liquidity = formatUsdCompact(market.liquidityUsd);
  const volume = marketVolumeFor(market, Date.now());
  const volumeText = formatUsdCompact(volume.value);
  const price = market.priceChange24hPct;
  const priceText =
    price === null ? "—" : `${price >= 0 ? "+" : ""}${Math.round(price * 10) / 10}%`;
  return (
    <span className="meta-item" title={title}>
      <span className="feed-pic" aria-hidden="true">
        <Pictogram name="market" size={16} />
      </span>{" "}
      Market {liquidity === null ? "can't tell" : liquidity} · {volume.label}{" "}
      {volumeText === null ? "can't tell" : volumeText} · {priceText}
    </span>
  );
}

export function LiveTokensList({
  snapshot,
  buffered = [],
  lastPollAt = null,
  sectionRef = null,
  onShowBuffered = null,
  tabbed = false,
  hidden = false,
  marketByToken,
  onCount = null,
  onTokens = null,
}: {
  readonly snapshot: LiveTokensSnapshot;
  readonly buffered?: readonly LiveTokenEntry[] | undefined;
  readonly lastPollAt?: number | null | undefined;
  readonly sectionRef?: RefObject<HTMLElement | null> | null | undefined;
  readonly onShowBuffered?: (() => void) | null | undefined;
  readonly tabbed?: boolean | undefined;
  readonly hidden?: boolean | undefined;
  readonly marketByToken: ReadonlyMap<string, MarketItem>;
  readonly onCount?: ((shown: number, total: number) => void) | null | undefined;
  readonly onTokens?: ((tokens: readonly string[]) => void) | null | undefined;
}): JSX.Element {
  const [filter, setFilter] = useState<Filter>("All");
  const [visible, setVisible] = useState(LIVE_PAGE_SIZE);
  // Fresh-row flash (Phosphor Console): rows the reader has not seen get
  // the in-place afterglow once. Everything on the first paint counts as
  // seen, so loading never flashes; later polls flash only their inserts.
  const [seen, setSeen] = useState<ReadonlySet<string>>(
    () => new Set(snapshot.items.map((entry) => entry.pairAddress)),
  );
  useEffect(() => {
    setSeen((previous) => {
      const next = new Set(previous);
      for (const entry of snapshot.items) {
        next.add(entry.pairAddress);
      }
      return next;
    });
  }, [snapshot.items]);

  const items = filterToEntries(snapshot.items, filter);
  const rows = items.slice(0, visible);

  useEffect(() => {
    onCount?.(Math.min(visible, items.length), items.length);
  }, [visible, items.length, onCount]);
  useEffect(() => {
    onTokens?.(snapshot.items.map((entry) => entry.tokenAddress.toLowerCase()));
  }, [snapshot.items, onTokens]);

  const panelProps = tabbed
    ? { role: "tabpanel" as const, id: "feed-panel-live", "aria-labelledby": "feed-tab-live" }
    : { role: undefined, id: undefined, "aria-labelledby": undefined };

  if (snapshot.status === "not-configured") {
    return (
      <section aria-label="New tokens" className="feed-section fade-sec" hidden={hidden} {...panelProps}>
        <h2 style={{ margin: "0 0 4px", fontSize: 20 }}>New tokens</h2>
        <div className="card" style={{ marginTop: 16 }}>
          <p className="muted" style={{ margin: 0 }}>
            New tokens are unavailable: this server is not set up to watch for them.
          </p>
        </div>
      </section>
    );
  }

  return (
    <section
      aria-label="New tokens"
      ref={sectionRef}
      className="feed-section fade-sec"
      style={{ "--sec-i": 2 } as CSSProperties}
      hidden={hidden}
      {...panelProps}
    >
      <div className="feedhead">
        <h2>New pairs</h2>
        <span className="count feed-count">
          <span className="meta-item">live from chain</span>
          <span className="meta-item">newest first</span>
          <span className="meta-item">
            <span className="live" style={{ fontSize: 12 }}>
              <i aria-hidden="true" />
              Live
            </span>
          </span>
        </span>
        {lastPollAt === null ? null : (
          <span className="quiet numeric">{feedStatusLabel(snapshot.updatedAt, lastPollAt)}</span>
        )}
        <div className="chips" role="group" aria-label="Risk filters">
          {FILTERS.map((name) => (
            <button
              key={name}
              type="button"
              className="chip"
              aria-pressed={filter === name}
              onClick={() => {
                setFilter(name);
                setVisible(LIVE_PAGE_SIZE);
              }}
            >
              {name}
            </button>
          ))}
        </div>
      </div>
      <p className="quiet numeric" aria-live="polite" style={{ margin: "8px 0 0" }}>
        {items.length <= visible ? tokenCountLabel(items.length) : `${visible} of ${items.length} new tokens`}
      </p>
      {/*
        Buffered-rows pill slot (S-124): always rendered at a fixed height
        so the pill appearing never moves the focused row by even a pixel.
      */}
      <p style={{ margin: "8px 0 0", minHeight: 44, display: "flex", alignItems: "center" }}>
        {buffered.length > 0 && onShowBuffered !== null ? (
          <button type="button" className="button-ghost" onClick={onShowBuffered}>
            {`${tokenCountLabel(buffered.length)} · Show`}
          </button>
        ) : null}
      </p>
      {items.length === 0 ? (
        filter === "All" ? (
          <div className="card" style={{ marginTop: 16 }}>
            <p className="muted" style={{ margin: 0 }}>
              Waiting for new pairs…
            </p>
          </div>
        ) : (
          <div className="card" style={{ marginTop: 16 }}>
            <p className="muted" style={{ margin: 0 }}>
              No tokens match this filter.
            </p>
            <p style={{ margin: "12px 0 0" }}>
              <button
                type="button"
                className="button-ghost"
                onClick={() => {
                  setFilter("All");
                  setVisible(LIVE_PAGE_SIZE);
                }}
              >
                Show all
              </button>
            </p>
          </div>
        )
      ) : (
        <>
          <ul className="feed-rows">
            {rows.map((entry) => {
              const fresh = !seen.has(entry.pairAddress);
              const age = ageProps(entry);
              return (
                <FeedRow
                  key={entry.pairAddress}
                  href={`#/token/${encodeURIComponent(entry.tokenAddress)}`}
                  symbol={entry.symbol}
                  tokenAddress={entry.tokenAddress}
                  name={entry.name}
                  ageLabel={age.label}
                  ageDateTime={age.dateTime}
                  ageTitle={age.title}
                  lamp={null}
                  chip={null}
                  score={riskCell(entry)}
                  meta={
                    <>
                      <span className="meta-item" title={`Pair ${entry.pairAddress}`}>
                        <span className="feed-pic" aria-hidden="true">
                          <Pictogram name="dex" size={16} />
                        </span>{" "}
                        {entry.dex}
                        {typeof entry.feeTier === "number" ? ` · ${entry.feeTier / 10000}%` : null}
                      </span>
                      <span className="meta-item">
                        <span className="feed-pic" aria-hidden="true">
                          <Pictogram name="liquidity" size={16} />
                        </span>{" "}
                        {entry.initialLiquidityWeth === null ? (
                          <span className="muted" title="No WETH liquidity seen in the pair's first logs">
                            can&apos;t tell
                          </span>
                        ) : (
                          `${entry.initialLiquidityWeth} WETH`
                        )}
                      </span>
                      {marketSegment(entry, marketByToken)}
                      <span className="meta-item">block {entry.block}</span>
                    </>
                  }
                  copyLabel="Copy contract address"
                  tokenTestId="live-token-full"
                  marker={
                    entry.ageSeconds !== null && entry.ageSeconds < 120 ? (
                      <span className="live-new">new</span>
                    ) : null
                  }
                  isNew={fresh}
                  isScored={entry.state === "done"}
                />
              );
            })}
          </ul>
          {items.length > visible ? (
            <p style={{ margin: "16px 0 0" }}>
              <button type="button" className="button-ghost" onClick={() => setVisible(visible + LIVE_PAGE_SIZE)}>
                Show {Math.min(LIVE_PAGE_SIZE, items.length - visible)} more
              </button>
            </p>
          ) : null}
        </>
      )}
    </section>
  );
}

// The list retries on its own, so a load failure is announced politely
// (role status) and never competes with the page's own alerts.
export function LiveTokensError({ message }: { readonly message: string }): JSX.Element {
  return (
    <section aria-label="New tokens" className="feed-section">
      <h2 style={{ margin: "0 0 4px", fontSize: 20 }}>New tokens</h2>
      <div className="card" style={{ marginTop: 16 }}>
        <p className="muted" style={{ margin: 0 }} role="status">
          {message}
        </p>
      </div>
    </section>
  );
}

export function LiveTokens({
  apiKey,
  marketByToken,
  tabbed = false,
  hidden = false,
  onCount = null,
  onTokens = null,
}: {
  readonly apiKey: string;
  readonly marketByToken: ReadonlyMap<string, MarketItem>;
  readonly tabbed?: boolean | undefined;
  readonly hidden?: boolean | undefined;
  readonly onCount?: ((shown: number, total: number) => void) | null | undefined;
  readonly onTokens?: ((tokens: readonly string[]) => void) | null | undefined;
}): JSX.Element {
  const [view, setView] = useState<{ snapshot: LiveTokensSnapshot; buffered: readonly LiveTokenEntry[] } | null>(null);
  const [lastPollAt, setLastPollAt] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const sectionRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    const readerEngaged = (): boolean => {
      if (typeof window !== "undefined" && window.scrollY > 0) {
        return true;
      }
      const root = sectionRef.current;
      return root !== null && root.contains(document.activeElement);
    };
    const load = (): void => {
      fetchLiveTokens(apiKey)
        .then((next) => {
          if (cancelled) {
            return;
          }
          setError(null);
          setLastPollAt(Date.now());
          setView((current) => {
            if (current === null || !readerEngaged()) {
              return { snapshot: next, buffered: [] };
            }
            return {
              snapshot: current.snapshot,
              buffered: unseenEntries(current.snapshot.items, next.items, current.buffered),
            };
          });
        })
        .catch(() => {
          if (!cancelled) {
            setError("Could not load new tokens. Retrying…");
          }
        });
    };
    load();
    const timer = setInterval(load, 10_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [apiKey]);

  if (error !== null && view === null) {
    return <LiveTokensError message={error} />;
  }

  if (view === null) {
    return (
      <section aria-label="New tokens" className="feed-section">
        <h2 style={{ margin: "0 0 4px", fontSize: 20 }}>New tokens</h2>
        <div className="card" style={{ marginTop: 16 }}>
          <p className="muted" style={{ margin: 0 }}>
            Loading new tokens…
          </p>
        </div>
      </section>
    );
  }

  const showBuffered = (): void => {
    setView((current) =>
      current === null
        ? current
        : { snapshot: { ...current.snapshot, items: mergeShown(current.snapshot.items, current.buffered) }, buffered: [] },
    );
  };

  return (
    <LiveTokensList
      snapshot={view.snapshot}
      buffered={view.buffered}
      lastPollAt={lastPollAt}
      sectionRef={sectionRef}
      onShowBuffered={view.buffered.length === 0 ? null : showBuffered}
      tabbed={tabbed}
      hidden={hidden}
      marketByToken={marketByToken}
      onCount={onCount}
      onTokens={onTokens}
    />
  );
}
