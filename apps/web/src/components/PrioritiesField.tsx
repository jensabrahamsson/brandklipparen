// Priorities field (S-066, K-035, P-24): "What matters to you?" The
// visitor's own words stay data: the value renders solely as the input
// value and, when echoed, as escaped text. Clearing removes the stored
// key. The deterministic baseline (P-25) never sends this text anywhere;
// only the explicit experimental AI personalize toggle (P-27) may send it
// for that one mapping call.
import type { JSX } from "react";

export function PrioritiesField({
  value,
  onChange,
  onClear,
}: {
  readonly value: string;
  readonly onChange: (text: string) => void;
  readonly onClear: () => void;
}): JSX.Element {
  return (
    <div style={{ margin: "0 0 16px" }}>
      <label htmlFor="priorities-field" style={{ display: "block", fontSize: 14, fontWeight: 600, marginBottom: 4 }}>
        What matters to you?
      </label>
      <input
        id="priorities-field"
        data-testid="priorities-field"
        className="input"
        type="text"
        value={value}
        maxLength={500}
        placeholder="Can the owner stop me selling? Can fees change? Can more tokens be minted?"
        onChange={(event) => onChange(event.target.value)}
        style={{ maxWidth: 560 }}
      />
      <div style={{ marginTop: 6, display: "flex", gap: 12, alignItems: "center" }}>
        <button
          type="button"
          data-testid="priorities-clear"
          className="button-ghost"
          disabled={value.length === 0}
          onClick={onClear}
        >
          Clear
        </button>
        <span className="quiet" style={{ fontSize: 13 }}>
          Stored only on this device. The deterministic order never sends it anywhere.
        </span>
      </div>
    </div>
  );
}
