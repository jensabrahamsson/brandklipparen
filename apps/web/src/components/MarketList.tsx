// DexScreener market list (DX-1 §A3, W-13): the promoted-tokens column
// beside New pairs. Polls /v1/market-new every 30 s; while the reader is
// focused inside the list or hovering it, unseen rows wait behind a
// "3 new · Show" pill instead of pushing rows down. Rows already shown
// always take the poll's updates, so they keep resolving instead of
// freezing. Rows are the shared FeedRow:
// symbol, compact age, owner-power chip, score when analysed, DEX,
// liquidity and volume, then the full token address with copy. The frame
// uses the dashed "outside the score" rule. Display only: nothing here
// touches scoring, signals or evidence.
import { useEffect, useRef, useState, type JSX } from "react";
import { riskBand } from "../lib/risk.ts";
import { formatAgeCompact, isSectionEngaged } from "../lib/liveTokens.ts";
import {
  fetchMarketNew,
  formatUsdCompact,
  marketAgeSeconds,
  marketChip,
  marketCountLabel,
  marketShownLabel,
  marketStatusLabel,
  marketVolumeFor,
  mergeMarketShown,
  nextMarketView,
  type MarketItem,
  type MarketSnapshot,
  type RecentAnalysis,
} from "../lib/market.ts";
import { toChecksumAddress } from "../lib/checksumAddress.ts";
import { FeedRow } from "./FeedRow.tsx";
import { Pictogram } from "./Pictogram.tsx";
import { RiskBadge } from "./RiskBadge.tsx";

// Market list page size (W-12): 10 rows plus "Show 10 more", matching
// the live list so the start page stays under its height budget.
const PAGE_SIZE = 10;

// Poll cadence for the market listing (DX-1 §A3.1): about every 30 s.
const MARKET_POLL_MS = 30_000;

function lampClass(word: string): string {
  return word === "Low" ? "feed-lamp-low" : word === "Elevated" ? "feed-lamp-elevated" : "feed-lamp-high";
}

function lampFor(item: MarketItem, recentByToken: ReadonlyMap<string, RecentAnalysis>): JSX.Element | null {
  const chip = marketChip(item, recentByToken);
  if (chip.kind === "powers") {
    const word = riskBand(item.analysis?.score ?? 0).word;
    const glyph = chip.found > 0 ? "found" : "extended";
    return (
      <span className={`feed-lamp ${lampClass(word)}`} aria-hidden="true">
        <Pictogram name={glyph} size={20} />
      </span>
    );
  }
  if (chip.kind === "none") {
    return (
      <span className="feed-lamp feed-lamp-dim" aria-hidden="true">
        <Pictogram name="notfound" size={20} />
      </span>
    );
  }
  if (chip.kind === "recent") {
    return (
      <span className={`feed-lamp ${lampClass(riskBand(chip.score).word)}`} aria-hidden="true">
        <Pictogram name="found" size={20} />
      </span>
    );
  }
  return (
    <span className="feed-lamp feed-lamp-dim" aria-hidden="true">
      <Pictogram name="notrun" size={20} />
    </span>
  );
}

function chipFor(item: MarketItem, recentByToken: ReadonlyMap<string, RecentAnalysis>): JSX.Element | null {
  const chip = marketChip(item, recentByToken);
  if (chip.kind === "powers") {
    if (chip.found > 0) {
      // Short chip (U-12): the full line-1 row must stay within the 130 px
      // phone budget, so extended findings read as "+N" with their
      // meaning in the tooltip. The feed carries no score-floor data,
      // so the tooltip never claims a finding is outside the score:
      // a proven power may set the minimum score on the token page.
      // The score never renders beside the chip: the chip replaces
      // the score bar and text (P9).
      return (
        <span
          className="feed-chip"
          title={
            chip.extended > 0
              ? `${chip.found} owner powers, ${chip.extended} more found by extended analysis`
              : `${chip.found} owner powers`
          }
        >
          ● {chip.found} power{chip.found === 1 ? "" : "s"}
          {chip.extended > 0 ? ` +${chip.extended}` : null}
        </span>
      );
    }
    return <span className="feed-chip">◌ {chip.extended} by extended analysis</span>;
  }
  if (chip.kind === "none") {
    return <span className="feed-chip feed-chip-dim">○ No owner power found</span>;
  }
  if (chip.kind === "unscanned") {
    return <span className="feed-chip feed-chip-dim">◌ Not scanned</span>;
  }
  return null;
}

function scoreFor(item: MarketItem, recentByToken: ReadonlyMap<string, RecentAnalysis>): JSX.Element | null {
  // U-12 (P9): analysed rows show the owner-power chip instead of any
  // score, so only a recent visit (analysis known from this browser, no
  // attached summary) keeps its compact score text.
  const chip = marketChip(item, recentByToken);
  if (chip.kind === "recent") {
    return (
      <span className="feed-score numeric">
        <RiskBadge score={chip.score} />
      </span>
    );
  }
  return null;
}

// Line 2 carries three items (U-12): DEX, liquidity and volume. The
// 24 h price move is dropped: on newborn pairs it is noise, and the
// fourth item pushed phone rows past the 130 px budget.
function metaFor(item: MarketItem, updatedTitle: string): JSX.Element {
  const liquidity = formatUsdCompact(item.liquidityUsd);
  const volume = marketVolumeFor(item, Date.now());
  const volumeText = formatUsdCompact(volume.value);
  return (
    <>
      <span className="meta-item" title={`Pair ${toChecksumAddress(item.pairAddress)}`}>
        <span className="feed-pic" aria-hidden="true">
          <Pictogram name="dex" size={16} />
        </span>{" "}
        {item.dex}
      </span>
      <span className="meta-item" title={updatedTitle}>
        <span className="feed-pic" aria-hidden="true">
          <Pictogram name="liquidity" size={16} />
        </span>{" "}
        {liquidity === null ? (
          <span className="muted" title="DexScreener did not report liquidity">
            can&apos;t tell
          </span>
        ) : (
          liquidity
        )}
      </span>
      <span className="meta-item" title={updatedTitle}>
        <span className="feed-pic" aria-hidden="true">
          <Pictogram name="volume" size={16} />
        </span>{" "}
        {volume.label}{" "}
        {volumeText === null ? <span className="muted">can&apos;t tell</span> : volumeText}
      </span>
    </>
  );
}

export function MarketListRows({
  snapshot,
  buffered = [],
  onShowBuffered = null,
  visible: visibleProp = null,
  onVisible = null,
  recentByToken,
  liveTokens,
  tokenTestId = "market-token-full",
}: {
  readonly snapshot: MarketSnapshot;
  readonly buffered?: readonly MarketItem[] | undefined;
  readonly onShowBuffered?: (() => void) | null | undefined;
  readonly visible?: number | null | undefined;
  readonly onVisible?: ((visible: number) => void) | null | undefined;
  readonly recentByToken: ReadonlyMap<string, RecentAnalysis>;
  readonly liveTokens: ReadonlySet<string>;
  readonly tokenTestId?: string | undefined;
}): JSX.Element {
  const [visible, setVisible] = useState(PAGE_SIZE);
  const shown = visibleProp ?? visible;
  const items = snapshot.items;
  const rows = items.slice(0, shown);
  const updatedTitle = `DexScreener, ${marketStatusLabel(snapshot.updatedAt, Date.now()).toLowerCase()}`;

  // Fresh-row flash: rows the reader has not seen get the in-place
  // afterglow once. The first paint counts as seen, so loading never
  // flashes; later polls flash only their inserts.
  const [seen, setSeen] = useState<ReadonlySet<string>>(
    () => new Set(items.map((entry) => entry.tokenAddress.toLowerCase())),
  );
  useEffect(() => {
    setSeen((previous) => {
      const next = new Set(previous);
      for (const entry of items) {
        next.add(entry.tokenAddress.toLowerCase());
      }
      return next;
    });
  }, [items]);

  return (
    <>
      <p className="quiet numeric" aria-live="polite" style={{ margin: "4px 0 0" }}>
        {marketShownLabel(Math.min(shown, items.length), items.length)}
      </p>
      {/*
        Buffered-rows pill (S-124, U-12): rendered only while unseen rows
        wait, as a floating overlay with no in-flow height. The pill
        appearing never moves an existing row by even a pixel, and the
        list keeps no dead gap between the count line and the rows.
      */}
      {buffered.length > 0 && onShowBuffered !== null ? (
        <div className="feed-buffer">
          <button type="button" className="button-ghost" onClick={onShowBuffered}>
            {`${marketCountLabel(buffered.length)} · Show`}
          </button>
        </div>
      ) : null}
      {items.length === 0 ? (
        <div className="card" style={{ marginTop: 16 }}>
          <p className="muted" style={{ margin: 0 }}>
            No Ethereum tokens promoted in the last 24 h.
          </p>
        </div>
      ) : (
        <>
          <ul className="feed-rows">
            {rows.map((entry) => {
              const key = entry.tokenAddress.toLowerCase();
              const fresh = !seen.has(key);
              const ageSeconds = marketAgeSeconds(entry.createdAt, Date.now());
              return (
                <FeedRow
                  key={entry.tokenAddress}
                  href={`#/token/${encodeURIComponent(entry.tokenAddress)}`}
                  symbol={entry.symbol}
                  tokenAddress={entry.tokenAddress}
                  name={entry.name}
                  ageLabel={formatAgeCompact(ageSeconds)}
                  ageDateTime={new Date(entry.createdAt).toISOString()}
                  ageTitle={`Listed ${new Date(entry.createdAt).toISOString()}`}
                  lamp={lampFor(entry, recentByToken)}
                  chip={chipFor(entry, recentByToken)}
                  score={scoreFor(entry, recentByToken)}
                  meta={
                    // The cross-list marker rides the meta line (U-12): it
                    // keeps line 1 to symbol, age, powers chip and score so
                    // rows stay within the 92 px desktop budget.
                    <>
                      {metaFor(entry, updatedTitle)}
                      {liveTokens.has(key) ? (
                        <span className="feed-chip feed-chip-dim">Also in New pairs</span>
                      ) : null}
                    </>
                  }
                  copyLabel="Copy contract address"
                  tokenTestId={tokenTestId}
                  marker={
                    ageSeconds !== null && ageSeconds < 120 ? <span className="live-new">new</span> : null
                  }
                  isNew={fresh}
                  isScored={entry.analysis !== undefined}
                />
              );
            })}
          </ul>
          {items.length > shown ? (
            <p style={{ margin: "16px 0 0" }}>
              <button
                type="button"
                className="button-ghost"
                onClick={() => {
                  const next = shown + PAGE_SIZE;
                  if (visibleProp === null) {
                    setVisible(next);
                  }
                  onVisible?.(next);
                }}
              >
                Show {Math.min(PAGE_SIZE, items.length - shown)} more
              </button>
            </p>
          ) : null}
        </>
      )}
    </>
  );
}

export function MarketList({
  apiKey,
  recentByToken,
  liveTokens,
  tabbed,
  hidden,
  onCount,
  onMarket,
  onUnavailable,
}: {
  readonly apiKey: string;
  readonly recentByToken: ReadonlyMap<string, RecentAnalysis>;
  readonly liveTokens: ReadonlySet<string>;
  readonly tabbed: boolean;
  readonly hidden: boolean;
  readonly onCount: (shown: number, total: number) => void;
  readonly onMarket: (items: readonly MarketItem[]) => void;
  readonly onUnavailable: () => void;
}): JSX.Element {
  const [view, setView] = useState<{ snapshot: MarketSnapshot; buffered: readonly MarketItem[] } | null>(null);
  const [lastPollAt, setLastPollAt] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [visible, setVisible] = useState(PAGE_SIZE);
  const sectionRef = useRef<HTMLElement | null>(null);
  const unavailableNotified = useRef(false);

  useEffect(() => {
    let cancelled = false;
    // Engagement is focus or hover inside the section (F-13 fix): scroll
    // position alone never freezes the rows.
    const readerEngaged = (): boolean => isSectionEngaged(sectionRef.current);
    const load = (): void => {
      fetchMarketNew(apiKey)
        .then((next) => {
          if (cancelled) {
            return;
          }
          if (next.status === "not-configured") {
            if (!unavailableNotified.current) {
              unavailableNotified.current = true;
              onUnavailable();
            }
            return;
          }
          setError(null);
          setLastPollAt(Date.now());
          setView((current) => nextMarketView(current, next, readerEngaged()));
        })
        .catch(() => {
          if (!cancelled) {
            setError("DexScreener didn't answer. On-chain pairs still work.");
          }
        });
    };
    load();
    const timer = setInterval(load, MARKET_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [apiKey, onUnavailable]);

  useEffect(() => {
    if (view !== null) {
      onCount(Math.min(visible, view.snapshot.items.length), view.snapshot.items.length);
      onMarket(view.snapshot.items);
    }
  }, [view, visible, onCount, onMarket]);

  const showBuffered = (): void => {
    setView((current) =>
      current === null
        ? current
        : { snapshot: { ...current.snapshot, items: mergeMarketShown(current.snapshot.items, current.buffered) }, buffered: [] },
    );
  };

  const retry = (): void => {
    setError(null);
    fetchMarketNew(apiKey)
      .then((next) => {
        if (next.status === "not-configured") {
          onUnavailable();
          return;
        }
        setLastPollAt(Date.now());
        setView({ snapshot: next, buffered: [] });
      })
      .catch(() => {
        setError("DexScreener didn't answer. On-chain pairs still work.");
      });
  };

  const panelProps = tabbed
    ? { role: "tabpanel" as const, id: "feed-panel-market", "aria-labelledby": "feed-tab-market" }
    : { role: undefined, id: undefined, "aria-labelledby": undefined };

  if (view === null && error !== null) {
    return (
      <section aria-label="Promoted on DexScreener" className="feed-section market-frame" hidden={hidden} {...panelProps}>
        <div className="feedhead">
          <h2>Promoted on DexScreener</h2>
        </div>
        <p className="feed-sub">Tokens someone paid to promote. Market data from DexScreener. Not part of the score.</p>
        <div className="card" style={{ marginTop: 16 }}>
          <p className="muted" style={{ margin: 0 }} role="status">
            {error}
          </p>
          <p style={{ margin: "12px 0 0" }}>
            <button type="button" className="button-ghost" onClick={retry}>
              Retry
            </button>
          </p>
        </div>
      </section>
    );
  }

  if (view === null) {
    return (
      <section aria-label="Promoted on DexScreener" className="feed-section market-frame" hidden={hidden} {...panelProps}>
        <div className="feedhead">
          <h2>Promoted on DexScreener</h2>
        </div>
        <p className="feed-sub">Tokens someone paid to promote. Market data from DexScreener. Not part of the score.</p>
        <div className="card" style={{ marginTop: 16 }}>
          <p className="muted" style={{ margin: 0 }}>
            Loading market listings…
          </p>
        </div>
      </section>
    );
  }

  return (
    <section
      aria-label="Promoted on DexScreener"
      ref={sectionRef}
      className="feed-section market-frame"
      hidden={hidden}
      {...panelProps}
    >
      <div className="feedhead">
        <h2>Promoted on DexScreener</h2>
        <span className="count feed-count">
          <span className="meta-item">Ethereum only</span>
          <span className="meta-item">newest first</span>
          <span className="meta-item">Market data</span>
        </span>
        {lastPollAt === null ? null : (
          <span className="quiet numeric">{marketStatusLabel(view.snapshot.updatedAt, lastPollAt)}</span>
        )}
      </div>
      <p className="feed-sub">Tokens someone paid to promote. Market data from DexScreener. Not part of the score.</p>
      <MarketListRows
        snapshot={view.snapshot}
        buffered={view.buffered}
        onShowBuffered={view.buffered.length === 0 ? null : showBuffered}
        visible={visible}
        onVisible={setVisible}
        recentByToken={recentByToken}
        liveTokens={liveTokens}
      />
    </section>
  );
}
