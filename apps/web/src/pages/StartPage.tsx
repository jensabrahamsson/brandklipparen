import { useState, type JSX } from "react";
import { ChainSelector } from "../components/ChainSelector.tsx";
import { isValidAddress, normalizeAddress, validationMessage } from "../lib/validate.ts";

// Start page (K-020): one search field for a contract address, chain
// selector, and the Just-deployed list. The deployment feed (K-014) is not
// wired yet, so the list renders an honest empty state instead of fake
// chain data. Filter chips are present and filter the (currently empty)
// list in place.
const FILTERS = ["All", "High risk", "Low risk", "Unverified only"] as const;

export function StartPage({
  chain,
  apiKey,
  onChainChange,
  onApiKeyChange,
  onAnalyze,
}: {
  readonly chain: string;
  readonly apiKey: string;
  readonly onChainChange: (chain: string) => void;
  readonly onApiKeyChange: (key: string) => void;
  readonly onAnalyze: (address: string) => void;
}): JSX.Element {
  const [raw, setRaw] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<(typeof FILTERS)[number]>("All");

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
      <h1 className="hero-title">Know the risk before you buy.</h1>
      <p className="hero-sub">
        Paste a contract address. Rug pull, honeypot and bot-pump risk from bytecode alone, explained in plain
        English.
      </p>
      <form onSubmit={submit} noValidate>
        <div className="search-row">
          <label htmlFor="address-search" className="skip-link">
            Contract address
          </label>
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
          <button type="submit" className="button">
            Analyze
          </button>
        </div>
        {error !== null ? (
          <p id="address-error" className="field-error numeric" role="alert" style={{ maxWidth: 720, marginLeft: "auto", marginRight: "auto" }}>
            {error}
          </p>
        ) : null}
      </form>
      <div
        style={{ display: "flex", gap: 16, justifyContent: "center", marginTop: 16, flexWrap: "wrap", alignItems: "center" }}
      >
        <ChainSelector chain={chain} onChange={onChainChange} />
        <label style={{ display: "inline-flex", alignItems: "center", gap: 8, fontSize: 14 }} className="muted">
          API key
          <input
            type="password"
            className="input"
            style={{ width: 200, fontFamily: "var(--font-sans)", fontSize: 14 }}
            autoComplete="off"
            placeholder="Demo key"
            value={apiKey}
            onChange={(event) => onApiKeyChange(event.target.value)}
            aria-label="REST API key for the demo"
          />
        </label>
      </div>
      <section aria-label="Just deployed" style={{ marginTop: 56 }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 12, flexWrap: "wrap" }}>
          <h2 style={{ margin: 0, fontSize: 20 }}>Just deployed</h2>
          <span className="quiet">Live feed not connected yet</span>
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
        <div className="card" style={{ marginTop: 16 }}>
          <p className="muted" style={{ margin: 0 }}>
            No deployments to show: the just-deployed feed is not connected yet, so this list stays empty rather
            than showing sample data as live. Paste a contract address above to analyze it
            {filter === "All" ? "" : ` (filter: ${filter})`}.
          </p>
        </div>
      </section>
      <section aria-label=" Guarantees" style={{ marginTop: 32 }}>
        <div style={{ display: "flex", gap: 24, flexWrap: "wrap" }} className="muted">
          <span>Works on unverified contracts</span>
          <span>Evidence for every signal</span>
          <span>Explained by Muse</span>
        </div>
      </section>
    </div>
  );
}
