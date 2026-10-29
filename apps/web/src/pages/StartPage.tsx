import { useState, type CSSProperties, type JSX } from "react";
import { ChainSelector } from "../components/ChainSelector.tsx";
import { toChecksumAddress } from "../lib/checksumAddress.ts";
import { CopyButton } from "../components/CopyButton.tsx";
import { LiveTokens } from "../components/LiveTokens.tsx";
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

// Start page: one search field for a contract address, the mainnet-only
// chain badge, and the live new-tokens list below it.

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
  const [recent] = useState<RecentEntry[]>(loadRecent);

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
          <p className="boot">BK/1 · ERC-20 contract reader · ready</p>
          <h1 className="hero-title">
            Scan before
            <br />
            <em>you ape.</em>
          </h1>
          <p className="hero-sub">
            Paste a contract address. Rug pull, honeypot and bot-pump risk from bytecode alone, explained in plain
            English.
          </p>
          <form onSubmit={submit} noValidate className="prompt">
            <span className="prompt-mark" aria-hidden="true">
              &gt;
            </span>
            <div className="field">
              <div className="search-row">
                <label htmlFor="address-search" className="skip-link">
                  Contract address
                </label>
                {raw.length === 0 ? (
                  <span className="cursor" aria-hidden="true" />
                ) : null}
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
      <div
        style={{ display: "flex", gap: 16, justifyContent: "center", marginTop: 16, flexWrap: "wrap", alignItems: "center" }}
      >
        <ChainSelector />
        <details className="muted" style={{ fontSize: 14 }}>
          <summary style={{ cursor: "pointer" }}>Settings</summary>
          <label style={{ display: "inline-flex", alignItems: "center", gap: 8, fontSize: 14, marginTop: 8 }} className="muted">
            API key
            <input
              type="password"
              className="input"
              style={{ width: 200, fontFamily: "var(--font-sans)", fontSize: 14 }}
              autoComplete="off"
              placeholder="Demo key"
              value={apiKey}
              onChange={(event) => onApiKeyChange(event.target.value)}
              aria-label="API key for the demo"
            />
          </label>
        </details>
      </div>
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
      <LiveTokens apiKey={apiKey} />
      <section aria-label="Guarantees" style={{ marginTop: 32 }}>
        <div style={{ display: "flex", gap: 24, flexWrap: "wrap" }} className="muted">
          <span>Works on unverified contracts</span>
          <span>Evidence for every signal</span>
          <span>Deterministic score · optional Muse assessment</span>
        </div>
      </section>
    </div>
  );
}
