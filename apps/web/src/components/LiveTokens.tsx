import { useEffect, useRef, useState, type CSSProperties, type JSX, type RefObject } from "react";
import { toChecksumAddress } from "../lib/checksumAddress.ts";
import { riskBand } from "../lib/risk.ts";
import { RiskBadge } from "./RiskBadge.tsx";
import { CopyButton } from "./CopyButton.tsx";
import {
  fetchLiveTokens,
  feedStatusLabel,
  filterLiveEntries,
  formatAge,
  mergeShown,
  shortAddress,
  tokenCountLabel,
  unseenEntries,
} from "../lib/liveTokens.ts";
import type { LiveFilter, LiveTokenEntry, LiveTokensSnapshot } from "../lib/liveTokens.ts";

// Live new-tokens list: a calm table of fresh Uniswap V2/V3 pairs,
// newest first, polled every ~10 s. Rows never jump: while the reader is
// scrolled or focused inside the list, new rows wait in a buffer behind a
// "N new tokens · Show" pill instead of pushing the table down.
// The count line is the single polite live region; the table itself is
// not one, so screen readers hear the count, not every row.
const FILTERS = ["All", "Elevated & high", "Low"] as const;

type Filter = (typeof FILTERS)[number];

function filterToEntries(items: readonly LiveTokenEntry[], filter: Filter): readonly LiveTokenEntry[] {
  return filterLiveEntries(items, filter as LiveFilter);
}

// Age reads as a human phrase from the feed's own chain timestamp; the
// block number rides in the tooltip as provenance. An unknown chain age
// reads as a quiet labelled "unknown" with the reason, never a bare "-"
// that looks like a bug.
function ageText(entry: LiveTokenEntry): JSX.Element | string {
  const text = formatAge(entry.ageSeconds);
  if (text !== "unknown") {
    return (
      <span title={`Block ${entry.block}`}>
        {text}
      </span>
    );
  }
  return (
    <span
      className="quiet"
      title={`Pair creation time not reported by the feed (block ${entry.block})`}
    >
      unknown
    </span>
  );
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
        can't tell
      </span>
    );
  }
  if (entry.state === "skipped") {
    return <span className="muted">skipped</span>;
  }
  return <span className="muted">{entry.reason ?? "error"}</span>;
}

export function LiveTokensList({
  snapshot,
  buffered = [],
  lastPollAt = null,
  sectionRef = null,
  onShowBuffered = null,
}: {
  readonly snapshot: LiveTokensSnapshot;
  readonly buffered?: readonly LiveTokenEntry[] | undefined;
  readonly lastPollAt?: number | null | undefined;
  readonly sectionRef?: RefObject<HTMLElement | null> | null | undefined;
  readonly onShowBuffered?: (() => void) | null | undefined;
}): JSX.Element {
  const [filter, setFilter] = useState<Filter>("All");
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
  const rowClass = (entry: LiveTokenEntry): string | undefined => {
    const fresh = !seen.has(entry.pairAddress);
    if (!fresh) {
      return undefined;
    }
    return entry.state === "done" ? "is-new is-scored" : "is-new";
  };
  if (snapshot.status === "not-configured") {
    return (
      <section aria-label="New tokens" style={{ marginTop: 56 }}>
        <h2 style={{ margin: "0 0 4px", fontSize: 20 }}>New tokens</h2>
        <div className="card" style={{ marginTop: 16 }}>
          <p className="muted" style={{ margin: 0 }}>
            New tokens are unavailable: this server is not set up to watch for them.
          </p>
        </div>
      </section>
    );
  }

  const items = filterToEntries(snapshot.items, filter);
  const sourceLabel =
    snapshot.source === "none"
      ? "Live feed"
      : snapshot.source === "rpc"
        ? "Live feed · via RPC"
        : "Live feed · via Etherscan";

  return (
    <section
      aria-label="New tokens"
      ref={sectionRef}
      className="fade-sec"
      style={{ marginTop: 56, "--sec-i": 2 } as CSSProperties}
    >
      <div className="feedhead">
        <h2>New pairs</h2>
        <span className="count feed-count">
          <span className="meta-item">{sourceLabel}</span>
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
              onClick={() => setFilter(name)}
            >
              {name}
            </button>
          ))}
        </div>
      </div>
      <p className="quiet numeric" aria-live="polite" style={{ margin: "8px 0 0" }}>
        {tokenCountLabel(items.length)}
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
              <button type="button" className="button-ghost" onClick={() => setFilter("All")}>
                Show all
              </button>
            </p>
          </div>
        )
      ) : (
        <>
          <ul className="live-cards">
            {items.map((entry) => (
              <li key={entry.pairAddress} className={rowClass(entry) === undefined ? "live-card" : `live-card ${rowClass(entry)}`}>
                <div className="live-card-top">
                  <a
                    href={`#/token/${encodeURIComponent(entry.tokenAddress)}`}
                    title={toChecksumAddress(entry.tokenAddress)}
                  >
                    {entry.symbol ?? shortAddress(entry.tokenAddress)}
                  </a>
                  {riskCell(entry)}
                </div>
                <div className="quiet numeric live-sub">
                  <span className="meta-item">{ageText(entry)}</span>
                  <span className="meta-item">
                    {entry.dex}
                    {typeof entry.feeTier === "number" ? ` · ${entry.feeTier / 10000}%` : null}
                  </span>
                  <span className="meta-item">
                    <span
                      className="muted"
                      title={
                        entry.initialLiquidityWeth === null
                          ? "No WETH liquidity seen in the pair's first logs"
                          : undefined
                      }
                    >
                      {entry.initialLiquidityWeth === null ? "can't tell" : `${entry.initialLiquidityWeth} WETH`}
                    </span>
                  </span>
                </div>
                <div className="live-addr">
                  <span className="addr-full mono numeric" data-testid="live-card-token-full">
                    {toChecksumAddress(entry.tokenAddress)}
                  </span>{" "}
                  <CopyButton value={toChecksumAddress(entry.tokenAddress)} label="Copy contract address" />
                </div>
                <div className="live-pair-full">
                  <span className="meta-item meta-addr pair-group">
                    Pair{" "}
                    <span className="addr-full mono numeric" data-testid="live-card-pair-full">
                      {toChecksumAddress(entry.pairAddress)}
                    </span>{" "}
                    <CopyButton value={toChecksumAddress(entry.pairAddress)} label="Copy pair address" />
                  </span>
                  <span className="meta-item">block {entry.block}</span>
                </div>
                <div className="quiet numeric live-meta">
                  <span className="meta-item">{ageText(entry)}</span>
                  <span className="meta-item">
                    {entry.dex}
                    {typeof entry.feeTier === "number" ? ` · ${entry.feeTier / 10000}%` : null}
                  </span>
                  <span className="meta-item">
                    <span
                      className="muted"
                      title={
                        entry.initialLiquidityWeth === null
                          ? "No WETH liquidity seen in the pair's first logs"
                          : undefined
                      }
                    >
                      {entry.initialLiquidityWeth === null ? "can't tell" : `${entry.initialLiquidityWeth} WETH`}
                    </span>
                  </span>
                </div>
                <div className="quiet numeric live-pair">
                  <span className="meta-item meta-addr pair-group">
                    Pair{" "}
                    <span className="addr-full mono numeric" data-testid="live-card-pair-full-wide">
                      {toChecksumAddress(entry.pairAddress)}
                    </span>{" "}
                    <CopyButton value={toChecksumAddress(entry.pairAddress)} label="Copy pair address" />
                  </span>
                  <span className="meta-item">block {entry.block}</span>
                </div>
              </li>
            ))}
          </ul>
          <div className="card live-table-wrap" style={{ marginTop: 16, padding: 8 }}>
            <table className="live-table">
            <caption className="skip-link">New Uniswap pairs, newest first</caption>
            <thead>
              <tr>
                <th scope="col">Token</th>
                <th scope="col">Address</th>
                <th scope="col">Age</th>
                <th scope="col">Pair/DEX</th>
                <th scope="col">Liquidity</th>
                <th scope="col">Risk</th>
              </tr>
            </thead>
            <tbody>
              {items.map((entry) => (
                <tr key={entry.pairAddress} className={rowClass(entry)}>
                  <td>
                    <a
                      href={`#/token/${encodeURIComponent(entry.tokenAddress)}`}
                      title={toChecksumAddress(entry.tokenAddress)}
                    >
                      {entry.symbol ?? shortAddress(entry.tokenAddress)}
                    </a>
                    {entry.ageSeconds !== null && entry.ageSeconds < 120 ? (
                      <span className="live-new">new</span>
                    ) : null}
                  </td>
                  <td className="mono numeric addr-cell">
                    <span className="addr-full" data-testid="live-token-full">
                      {toChecksumAddress(entry.tokenAddress)}
                    </span>{" "}
                    <CopyButton value={toChecksumAddress(entry.tokenAddress)} label="Copy contract address" />
                  </td>
                  <td className="numeric">{ageText(entry)}</td>
                  <td className="addr-cell">
                    {entry.dex}
                    {typeof entry.feeTier === "number" ? ` · ${entry.feeTier / 10000}%` : null} ·{" "}
                    <span className="addr-full mono numeric" data-testid="live-pair-full">
                      {toChecksumAddress(entry.pairAddress)}
                    </span>{" "}
                    <CopyButton value={toChecksumAddress(entry.pairAddress)} label="Copy pair address" />
                  </td>
                  <td className="numeric">
                    {entry.initialLiquidityWeth === null ? (
                      <span className="muted" title="No WETH liquidity seen in the pair's first logs">
                        can't tell
                      </span>
                    ) : (
                      `${entry.initialLiquidityWeth} WETH`
                    )}
                  </td>
                  <td>{riskCell(entry)}</td>
                </tr>
              ))}
            </tbody>
            </table>
          </div>
        </>
      )}
    </section>
  );
}

// The list retries on its own, so a load failure is announced politely
// (role status) and never competes with the page's own alerts.
export function LiveTokensError({ message }: { readonly message: string }): JSX.Element {
  return (
    <section aria-label="New tokens" style={{ marginTop: 56 }}>
      <h2 style={{ margin: "0 0 4px", fontSize: 20 }}>New tokens</h2>
      <div className="card" style={{ marginTop: 16 }}>
        <p className="muted" style={{ margin: 0 }} role="status">
          {message}
        </p>
      </div>
    </section>
  );
}

export function LiveTokens({ apiKey }: { readonly apiKey: string }): JSX.Element {
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
      <section aria-label="New tokens" style={{ marginTop: 56 }}>
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
    />
  );
}
