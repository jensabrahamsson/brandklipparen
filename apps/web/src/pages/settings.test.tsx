// Settings page: the API key field and the Animations switch, each
// with one plain line on what it does. Behavior based: rendered text,
// labels and links only.
import { describe, expect, test } from "vitest";
import { renderToString } from "react-dom/server";
import { SettingsPage } from "./SettingsPage.tsx";

describe("settings page", () => {
  test("settings_hold_api_key_and_animations_with_explanations", () => {
    const html = renderToString(<SettingsPage apiKey="" onApiKeyChange={() => {}} />);
    expect(html).toContain(">Settings</h1>");
    expect(html).toContain('for="settings-api-key"');
    expect(html).toContain("Your own key, if you have one. Kept only in this browser session.");
    expect(html).toContain('aria-label="Animations"');
    expect(html).toContain(">Animations<");
    expect(html).toContain("Blink and glow only. Off keeps everything still; your system reduced-motion setting always applies.");
    expect(html).toContain('href="#/"');
    expect(html).toContain("Back to search");
  });
});
