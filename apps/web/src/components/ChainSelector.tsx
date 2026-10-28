import type { JSX } from "react";
// Chain badge (S-029): Ethereum mainnet only (chainId 1). No wallet
// connection and no chain picker: the UI is read-only analysis on
// mainnet, and the backend turns every other chain id away with a typed
// error (S-091).
export function ChainSelector(): JSX.Element {
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 8, fontSize: 14 }} className="muted">
      Chain
      <span
        aria-label="Chain"
        style={{
          background: "var(--surface)",
          color: "var(--text)",
          border: "1px solid var(--border)",
          borderRadius: 8,
          padding: "6px 10px",
          fontFamily: "var(--font-sans)",
          fontSize: 14,
        }}
      >
        Ethereum mainnet
      </span>
    </span>
  );
}
