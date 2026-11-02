import { useCallback, useEffect, useMemo, useState, type CSSProperties, type JSX } from "react";
import { MotionSwitch } from "../components/MotionSwitch.tsx";
import { toChecksumAddress } from "../lib/checksumAddress.ts";
import { CopyButton } from "../components/CopyButton.tsx";
import { LiveTokens } from "../components/LiveTokens.tsx";
import { MarketList } from "../components/MarketList.tsx";
import { FeedTabs, readFeedTab, FEED_TAB_STORAGE_KEY, type FeedTabId } from "../components/FeedTabs.tsx";
import { fetchHealth } from "../lib/api.ts";
import { toMarketAvailability } from "../lib/capabilities.ts";
import { tokenCountLabel } from "../lib/liveTokens.ts";
import { marketShownLabel, type MarketItem, type RecentAnalysis } from "../lib/market.ts";
import { useMediaQuery } from "../lib/useMediaQuery.ts";
import { ELEVATED_BAND, HIGH_BAND, LOW_BAND, RISK_SHORT } from "../lib/risk.ts";
import { recentRowTitle } from "../lib/tokenIdentity.ts";
import { isValidAddress, normalizeAddress, validationMessage } from "../lib/validate.ts";

// Risk-score legend rows (Phosphor Console): band ranges straight from
// the frozen risk bands, with plain-language meanings. No feature data.
const LEGEND: readonly { readonly min: number; readonly max: number; readonly word: string; readonly meaning: string }[] = [
  { min: LOW_BAND.min, max: LOW_BAND.max, word: "Low", meaning: "no strong owner powers seen" },
  { min: ELEVATED_BAND.min, max: ELEVATED_BAND.max, word: "Elevated", meaning: "some risky capabilities" },
  { min: HIGH_BAND.min, max: HIGH_BAND.max, word: "High", meaning: "owner can hurt holders" },
];

// Example tokens under the search (D-14): a judge rarely has a contract
// address on the clipboard, so the first 30 seconds offer two demo
// links. USDT and PEPE are the review's named examples with their real
// mainnet addresses (owner-approved for this page only).
export const TRY_EXAMPLES: readonly { readonly name: string; readonly address: string }[] = [
  { name: "USDT", address: "0xdAC17F958D2ee523a2206206994597C13D831ec7" },
  { name: "PEPE", address: "0x6982508145454ce325ddbe47a25d4ec3d2311933" },
];

// Start page: one search field for a contract address, two example
// links below it, and the live new-tokens list below that.

type RecentEntry = {
  readonly address: string;
  readonly score: number;
  readonly word: string;
  readonly probabilities: Record<string, number>;
  readonly topSignal: string | null;
  // Display-only token identity written by the token page when the chain
  // answers: older rows without these fields read as null.
  readonly symbol?: string | null | undefined;
  readonly name?: string | null | undefined;
};

// Recently analyzed (design review P1-1): real results only, written by
// the token page after a successful analysis. Nothing is faked here: an
// empty store renders no rows.
function loadRecent(): RecentEntry[] {
  try {
    const raw = sessionStorage.getItem("brandklipparen-recent");
    if (raw === null) {
      return [];
    }
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.filter(
      (item): item is RecentEntry =>
        typeof item === "object" &&
        item !== null &&
        typeof (item as RecentEntry).address === "string" &&
        typeof (item as RecentEntry).score === "number" &&
        typeof (item as RecentEntry).probabilities === "object",
    );
  } catch {
    return [];
  }
}

export function StartPage({
  apiKey,
  onApiKeyChange,
  onAnalyze,
}: {
  readonly apiKey: string;
  readonly onApiKeyChange: (key: string) => void;
  readonly onAnalyze: (address: string) => void;
}): JSX.Element {
  const [raw, setRaw] = useState("");
  const [error, setError] = useState<string | null>(null);
  // The API-key field mounts only while its disclosure is open, so the
  // closed disclosure contributes no hidden-layout box to measure (the
  // layout contract counts every rendered control at every width).
  const [apiOpen, setApiOpen] = useState(false);
  const [recent] = useState<RecentEntry[]>(loadRecent);
  // DexScreener column (DX-1): visible only while /health reports the
  // market feed. A failed or silent health check hides the column rather
  // than flashing a wrong layout.
  const [marketAvailable, setMarketAvailable] = useState(false);
  const wide = useMediaQuery("(min-width: 1280px)");
  const [feedTab, setFeedTab] = useState<FeedTabId>(readFeedTab);
  // Tab counts and the cross-list join (W-13 "Also in New pairs" chip and
  // on-chain market enrichment) ride on callbacks, never on refetches.
  const [liveCount, setLiveCount] = useState<{ shown: number; total: number } | null>(null);
  const [marketCount, setMarketCount] = useState<{ shown: number; total: number } | null>(null);
  const [liveTokens, setLiveTokens] = useState<ReadonlySet<string>>(() => new Set());
  const [marketItems, setMarketItems] = useState<readonly MarketItem[]>([]);

  useEffect(() => {
    let cancelled = false;
    fetchHealth().then(
      (health) => {
        if (!cancelled) {
          setMarketAvailable(toMarketAvailability(health) === "available");
        }
      },
      () => {
        if (!cancelled) {
          setMarketAvailable(false);
        }
      },
    );
    return () => {
      cancelled = true;
    };
  }, []);

  const onSelectTab = useCallback((tab: FeedTabId) => {
    setFeedTab(tab);
    try {
      sessionStorage.setItem(FEED_TAB_STORAGE_KEY, tab);
    } catch {
      // Session storage is a convenience only; the choice still applies.
    }
  }, []);

  const onLiveCount = useCallback((shown: number, total: number) => {
    setLiveCount({ shown, total });
  }, []);
  const onMarketCount = useCallback((shown: number, total: number) => {
    setMarketCount({ shown, total });
  }, []);
  const onLiveTokens = useCallback((tokens: readonly string[]) => {
    setLiveTokens(new Set(tokens));
  }, []);
  const onMarket = useCallback((items: readonly MarketItem[]) => {
    setMarketItems(items);
  }, []);
  const onMarketUnavailable = useCallback(() => {
    setMarketAvailable(false);
  }, []);

  const recentByToken = useMemo(() => {
    const map = new Map<string, RecentAnalysis>();
    for (const entry of recent) {
      map.set(entry.address.toLowerCase(), { score: entry.score, word: entry.word });
    }
    return map;
  }, [recent]);
  const marketByToken = useMemo(() => {
    const map = new Map<string, MarketItem>();
    for (const item of marketItems) {
      map.set(item.tokenAddress.toLowerCase(), item);
    }
    return map;
  }, [marketItems]);

  const liveCountLabel =
    liveCount === null
      ? null
      : liveCount.total <= liveCount.shown
        ? tokenCountLabel(liveCount.total)
        : `${liveCount.shown} of ${liveCount.total} new tokens`;
  const marketCountLabel =
    marketCount === null ? null : marketShownLabel(marketCount.shown, marketCount.total);
  const showTabs = marketAvailable && !wide;

  const submit = (event: { preventDefault: () => void }): void => {
    event.preventDefault();
    const address = normalizeAddress(raw);
    if (!isValidAddress(address)) {
      setError(validationMessage(raw));
      return;
    }
    setError(null);
    onAnalyze(address);
  };

  return (
    <div className="page">
      <section className="hero">
        <div className="fade-sec" style={{ "--sec-i": 0 } as CSSProperties}>
          <h1 className="hero-title">
            Scan before
            <br />
            <em>you swap.</em>
          </h1>
          <p className="hero-sub">
            Paste a contract address. See what its owner can do to you, in plain English.
          </p>
          <form onSubmit={submit} noValidate className="prompt">
            <div className="field">
              <div className="search-row">
                <label htmlFor="address-search" className="skip-link">
                  Contract address
                </label>
                <span className="prompt-mark" aria-hidden="true">
                  &gt;
                </span>
                <input
                  id="address-search"
                  className="input"
                  type="text"
                  autoComplete="off"
                  spellCheck={false}
                  placeholder="Paste contract address, 0x…"
                  value={raw}
                  onChange={(event) => setRaw(event.target.value)}
                  aria-invalid={error !== null}
                  aria-describedby={error !== null ? "address-error" : undefined}
                />
                {error !== null ? (
                  <span className="field-error-icon" aria-hidden="true">
                    !
                  </span>
                ) : null}
                <button type="submit" className="button">
                  Analyze
                </button>
              </div>
            </div>
          </form>
          {error !== null ? (
            <p id="address-error" className="field-error numeric" role="alert" style={{ maxWidth: 720 }}>
              {error}
            </p>
          ) : null}
          <p className="try-row">
            <span id="try-label">Try:</span>{" "}
            <span className="try-chips" role="group" aria-labelledby="try-label">
              {TRY_EXAMPLES.map((example) => (
                <a key={example.address} className="try-chip" href={`#/token/${example.address}`}>
                  {example.name}
                </a>
              ))}
            </span>
          </p>
        </div>
        <aside className="legend fade-sec" aria-label="Risk score legend" style={{ "--sec-i": 1 } as CSSProperties}>
          <h3>Risk score · 0–100</h3>
          {LEGEND.map((row) => (
            <div className="legend-row" key={row.word}>
              <span>
                {row.min}–{row.max}
              </span>
              <span>{row.word.toUpperCase()}</span>
              <span className="dim">{row.meaning}</span>
            </div>
          ))}
          <p className="note">A score is a reading of the contract, not a promise. Every page lists what we can&apos;t tell.</p>
        </aside>
      </section>
      {recent.length > 0 ? (
        <section aria-label="Recently analyzed" style={{ marginTop: 56 }}>
          <h2 style={{ margin: "0 0 4px", fontSize: 20 }}>Recently analyzed</h2>
          <p className="quiet" style={{ margin: "0 0 12px" }}>
            From this browser only: addresses you analyzed here.
          </p>
          <ul className="recent-list" style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 12 }}>
            {recent.map((entry) => {
              const title = recentRowTitle(entry.symbol, entry.address);
              return (
              <li key={entry.address} className="row-card">
                <button
                  type="button"
                  className="button-ghost recent-row"
                  onClick={() => onAnalyze(entry.address)}
                  aria-label={`Re-analyze ${title}: score ${entry.score} ${entry.word}`}
                >
                  <span className="recent-title">{title}</span>
                  <span className="numeric" style={{ fontWeight: 700 }}>
                    {entry.score} {entry.word}
                  </span>
                  <span className="recent-bars" aria-hidden="true">
                    {(["rug-pull", "honeypot", "bot-pump"] as const).map((risk) => (
                      <span key={risk} className="recent-bar">
                        <span className="recent-bar-track">
                          <span
                            className="recent-bar-fill"
                            style={{ width: `${Math.round((entry.probabilities[risk] ?? 0) * 100)}%` }}
                          />
                        </span>
                        <span className="recent-bar-label">{RISK_SHORT[risk]}</span>
                      </span>
                    ))}
                  </span>
                  <span className="muted recent-top">{entry.topSignal ?? "No tracked risk patterns."}</span>
                </button>
                <div className="recent-meta">
                  <span className="addr-full mono numeric" data-testid="recent-address-full">
                    {toChecksumAddress(entry.address)}
                  </span>{" "}
                  <CopyButton value={toChecksumAddress(entry.address)} label="Copy contract address" />
                </div>
              </li>
              );
            })}
          </ul>
        </section>
      ) : null}
      {wide && marketAvailable ? (
        <div className="feed-cols">
          <LiveTokens
            apiKey={apiKey}
            marketByToken={marketByToken}
            tabbed={false}
            hidden={false}
            onCount={onLiveCount}
            onTokens={onLiveTokens}
          />
          <MarketList
            apiKey={apiKey}
            recentByToken={recentByToken}
            liveTokens={liveTokens}
            tabbed={false}
            hidden={false}
            onCount={onMarketCount}
            onMarket={onMarket}
            onUnavailable={onMarketUnavailable}
          />
        </div>
      ) : (
        <>
          {showTabs ? (
            <FeedTabs active={feedTab} onSelect={onSelectTab} liveCount={liveCountLabel} marketCount={marketCountLabel} />
          ) : null}
          <LiveTokens
            apiKey={apiKey}
            marketByToken={marketByToken}
            tabbed={showTabs}
            hidden={showTabs && feedTab !== "live"}
            onCount={onLiveCount}
            onTokens={onLiveTokens}
          />
          {marketAvailable ? (
            <MarketList
              apiKey={apiKey}
              recentByToken={recentByToken}
              liveTokens={liveTokens}
              tabbed={showTabs}
              hidden={showTabs && feedTab !== "market"}
              onCount={onMarketCount}
              onMarket={onMarket}
              onUnavailable={onMarketUnavailable}
            />
          ) : null}
        </>
      )}
      <footer className="page-foot">
        <span className="foot-trust">
          Deterministic score · Muse is advisory · Works on unverified contracts · Evidence for every signal
        </span>
        <details
          className="foot-api muted"
          open={apiOpen}
          onToggle={(event) => setApiOpen(event.currentTarget.open)}
        >
          <summary>API key</summary>
          {apiOpen ? (
            <label className="muted api-key-row">
              API key
              <input
                type="password"
                className="input"
                autoComplete="off"
                placeholder="Demo key"
                value={apiKey}
                onChange={(event) => onApiKeyChange(event.target.value)}
                aria-label="API key for the demo"
              />
            </label>
          ) : null}
        </details>
        <MotionSwitch />
        <span className="foot-model">Follows your system setting until switched off.</span>
      </footer>
    </div>
  );
}
