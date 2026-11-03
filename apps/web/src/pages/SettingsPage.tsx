import type { JSX } from "react";

// Settings: the API key lives here, with one plain line on what it
// does. Nothing else is stored. Motion follows only the operating
// system setting: under prefers-reduced-motion everything is static.
export function SettingsPage({
  apiKey,
  onApiKeyChange,
}: {
  readonly apiKey: string;
  readonly onApiKeyChange: (key: string) => void;
}): JSX.Element {
  return (
    <div className="page">
      <section aria-label="Settings">
        <h1 style={{ margin: "0 0 16px", fontSize: 28 }} tabIndex={-1}>
          Settings
        </h1>
        <div className="settings-row">
          <label className="settings-label" htmlFor="settings-api-key">
            API key
          </label>
          <input
            id="settings-api-key"
            type="password"
            className="input"
            autoComplete="off"
            placeholder="API key"
            value={apiKey}
            onChange={(event) => onApiKeyChange(event.target.value)}
          />
          <p className="muted settings-note">Your own key, if you have one. Kept only in this browser session.</p>
        </div>
        <p style={{ marginTop: 24 }}>
          <a className="foot-settings" href="#/">
            Back to search
          </a>
        </p>
      </section>
    </div>
  );
}
