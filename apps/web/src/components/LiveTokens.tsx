import { useEffect, useState, type JSX } from "react";
import { RiskBadge } from "./RiskBadge.tsx";
import { fetchLiveTokens, formatAge, shortAddress } from "../lib/liveTokens.ts";
import type { LiveTokenEntry, LiveTokensSnapshot } from "../lib/liveTokens.ts";

// Live new-tokens list: a calm table of fresh Uniswap V2/V3 pairs,
// newest first, polled every ~10 s. Rows never animate or reorder:
// stable keys, text-only updates, and at most a static "new" marker.
// The status line is the single polite live region; the table itself is
// not one, so screen readers hear the count, not every row.
const FILTERS = ["All", "High risk", "Low risk"] as const;

type Filter = (typeof FILTERS)[number];

function visibleEntries(items: readonly LiveTokenEntry[], filter: Filter): readonly LiveTokenEntry[] {
  if (filter === "High risk") {
    return items.filter((entry) => entry.riskBand === "High" || entry.riskBand === "Elevated");
  }
  if (filter === "Low risk") {
    return items.filter((entry) => entry.riskBand === "Low");
  }
  return items;
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

export function LiveTokensList({ snapshot }: { readonly snapshot: LiveTokensSnapshot }): JSX.Element {
  const [filter, setFilter] = useState<Filter>("All");
  if (snapshot.status === "not-configured") {
    return (
      <section aria-label="New tokens" style={{ marginTop: 56 }}>
        <h2 style={{ margin: "0 0 4px", fontSize: 20 }}>New tokens</h2>
        <div className="card" style={{ marginTop: 16 }}>
          <p className="muted" style={{ margin: 0 }}>
            Set an Etherscan key to see new tokens (ETHERSCAN_API_KEY or ETHERSCAN_API_KEY_FILE in .env.local).
          </p>
        </div>
      </section>
    );
  }

  const items = visibleEntries(snapshot.items, filter);
  const sourceLabel =
    snapshot.source === "none"
      ? "Live feed"
      : snapshot.source === "rpc"
        ? "Live feed · via RPC"
        : "Live feed · via Etherscan";

  return (
    <section aria-label="New tokens" style={{ marginTop: 56 }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 12, flexWrap: "wrap" }}>
        <h2 style={{ margin: 0, fontSize: 20 }}>New tokens</h2>
        <span className="quiet">{sourceLabel}</span>
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
      <p className="quiet" aria-live="polite" style={{ margin: "8px 0 0" }}>
        {`${items.length} new tokens`}
      </p>
      {items.length === 0 ? (
        <div className="card" style={{ marginTop: 16 }}>
          <p className="muted" style={{ margin: 0 }}>
            Waiting for new pairs…
          </p>
        </div>
      ) : (
        <div className="card" style={{ marginTop: 16, padding: 8 }}>
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
                  <td className="numeric">{formatAge(entry.ageSeconds)}</td>
                  <td>
                    {entry.dex}
                    {typeof entry.feeTier === "number" ? ` · ${entry.feeTier / 10000}%` : null} ·{" "}
                    <span className="muted">{shortAddress(entry.pairAddress)}</span>
                  </td>
                  <td className="numeric">
                    {entry.initialLiquidityWeth === null ? (
                      <span className="muted">can't tell</span>
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
  const [snapshot, setSnapshot] = useState<LiveTokensSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = (): void => {
      fetchLiveTokens(apiKey)
        .then((next) => {
          if (!cancelled) {
            setSnapshot(next);
            setError(null);
          }
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

  if (error !== null && snapshot === null) {
    return <LiveTokensError message={error} />;
  }

  if (snapshot === null) {
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

  return <LiveTokensList snapshot={snapshot} />;
}
