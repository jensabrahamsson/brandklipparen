// Settings page: the API key field with one plain line on what it
// does, and no motion switch anywhere: motion follows only the
// operating-system reduced-motion setting. Behavior based: rendered
// text, labels and links only.
import { describe, expect, test } from "vitest";
import { renderToString } from "react-dom/server";
import { SettingsPage } from "./SettingsPage.tsx";

describe("settings page", () => {
  test("settings_hold_api_key_with_explanation_and_no_motion_switch", () => {
    const html = renderToString(<SettingsPage apiKey="" onApiKeyChange={() => {}} />);
    expect(html).toContain(">Settings</h1>");
    expect(html).toContain('for="settings-api-key"');
    expect(html).toContain("Your own key, if you have one. Kept only in this browser session.");
    expect(html).not.toContain('aria-label="Animations"');
    expect(html).not.toContain("motion-switch");
    expect(html).toContain('href="#/"');
    expect(html).toContain("Back to search");
  });
});
