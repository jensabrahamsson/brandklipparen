// Priorities field (S-066, K-035, P-24): "What matters to you?" The
// visitor's own words stay data: the value renders solely as the input
// value and, when echoed, as escaped text. Clearing removes the stored
// key. The deterministic baseline (P-25) never sends this text anywhere;
// only the explicit experimental AI order toggle (P-27) may send it
// for that one mapping call.
import type { JSX } from "react";

export function PrioritiesField({
  value,
  onChange,
  onClear,
  aiOn,
  providerName,
}: {
  readonly value: string;
  readonly onChange: (text: string) => void;
  readonly onClear: () => void;
  readonly aiOn: boolean;
  readonly providerName: string;
}): JSX.Element {
  return (
    <div className="priorities">
      <label htmlFor="priorities-field" className="priorities-label">
        What matters to you?
      </label>
      <input
        id="priorities-field"
        data-testid="priorities-field"
        className="input priorities-input"
        type="text"
        value={value}
        maxLength={500}
        placeholder="Can the owner stop me selling? Can fees change? Can more tokens be minted?"
        onChange={(event) => onChange(event.target.value)}
      />
      <div className="priorities-row">
        <button
          type="button"
          data-testid="priorities-clear"
          className="button-ghost priorities-clear"
          disabled={value.length === 0}
          onClick={onClear}
        >
          Clear
        </button>
        <span className="quiet priorities-note">
          {aiOn
            ? `Stored on this device. Sent to ${providerName} only when you press Apply AI order.`
            : "Stored only on this device. The deterministic order never sends it anywhere."}
        </span>
      </div>
    </div>
  );
}
