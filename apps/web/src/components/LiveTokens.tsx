import { useEffect, useRef, useState, type JSX, type RefObject } from "react";
import { RiskBadge } from "./RiskBadge.tsx";
import {
  fetchLiveTokens,
  filterLiveEntries,
  formatAge,
  mergeShown,
  shortAddress,
  tokenCountLabel,
  unseenEntries,
  updatedAgoLabel,
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

function riskCell(entry: LiveTokenEntry): JSX.Element {
  if (entry.state === "done" && typeof entry.score === "number") {
    return <RiskBadge score={entry.score} />;
  }
  if (entry.state === "queued" || entry.state === "analyzing") {
    return <span className="muted">analyzing…</span>;
  }
  if (entry.state === "cant-tell") {
    return (
      <span className="muted" title={entry.reason ?? "missing data"}>
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
    <section aria-label="New tokens" ref={sectionRef} style={{ marginTop: 56 }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 12, flexWrap: "wrap" }}>
        <h2 style={{ margin: 0, fontSize: 20 }}>New tokens</h2>
        <span className="quiet">{sourceLabel}</span>
        {lastPollAt === null ? null : (
          <span className="quiet numeric">{updatedAgoLabel(snapshot.updatedAt, lastPollAt)}</span>
        )}
        <span style={{ flex: 1 }} />
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
              <li key={entry.pairAddress} className="live-card">
                <div className="live-card-top">
                  <a href={`#/token/${encodeURIComponent(entry.tokenAddress)}`} title={entry.tokenAddress}>
                    {entry.symbol ?? shortAddress(entry.tokenAddress)}
                  </a>
                  {riskCell(entry)}
                </div>
                <div className="quiet numeric">
                  {ageText(entry)} · {entry.dex}
                  {typeof entry.feeTier === "number" ? ` · ${entry.feeTier / 10000}%` : null} ·{" "}
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
                </div>
                <div className="quiet mono numeric" title={entry.pairAddress}>
                  {shortAddress(entry.pairAddress)} · block {entry.block}
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
                <th scope="col">Age</th>
                <th scope="col">Pair/DEX</th>
                <th scope="col">Liquidity</th>
                <th scope="col">Risk</th>
              </tr>
            </thead>
            <tbody>
              {items.map((entry) => (
                <tr key={entry.pairAddress}>
                  <td>
                    <a href={`#/token/${encodeURIComponent(entry.tokenAddress)}`} title={entry.tokenAddress}>
                      {entry.symbol ?? shortAddress(entry.tokenAddress)}
                    </a>
                    {entry.symbol === null ? null : (
                      <span className="muted"> {shortAddress(entry.tokenAddress)}</span>
                    )}
                    {entry.ageSeconds !== null && entry.ageSeconds < 120 ? (
                      <span className="live-new">new</span>
                    ) : null}
                  </td>
                  <td className="numeric">{ageText(entry)}</td>
                  <td>
                    {entry.dex}
                    {typeof entry.feeTier === "number" ? ` · ${entry.feeTier / 10000}%` : null} ·{" "}
                    <span className="muted">{shortAddress(entry.pairAddress)}</span>
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
