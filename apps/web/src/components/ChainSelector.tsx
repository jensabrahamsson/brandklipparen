import type { JSX } from "react";
// Chain selector (S-029): Ethereum mainnet today, ready for more chains
// later. No wallet connection: the UI is read-only analysis.
export function ChainSelector({
  chain,
  onChange,
}: {
  readonly chain: string;
  readonly onChange: (chain: string) => void;
}): JSX.Element {
  return (
    <label style={{ display: "inline-flex", alignItems: "center", gap: 8, fontSize: 14 }} className="muted">
      Chain
      <select
        value={chain}
        onChange={(event) => onChange(event.target.value)}
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
        <option value="ethereum">Ethereum mainnet</option>
      </select>
    </label>
  );
}
