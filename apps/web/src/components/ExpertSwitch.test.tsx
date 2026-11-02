// Expert switch unit tests (UI v2 §1.4, K-034): one `role="switch"` with
// a stable accessible name, reflecting the stored Simple / Expert mode.
// Behavior based: roles and accessible names only.
import { describe, expect, test } from "vitest";
import { renderToString } from "react-dom/server";
import { ExpertSwitch } from "./ExpertSwitch.tsx";

describe("expert switch (W-8)", () => {
  test("simple_mode_renders_switch_off_with_stable_name", () => {
    const html = renderToString(<ExpertSwitch mode="simple" onModeChange={() => undefined} />);
    expect(html).toContain('role="switch"');
    expect(html).toContain('aria-checked="false"');
    expect(html).toContain('aria-label="Expert view"');
    expect(html).toContain('data-testid="expert-switch"');
    expect(html).toContain("Expert view");
  });

  test("expert_mode_renders_switch_on", () => {
    const html = renderToString(<ExpertSwitch mode="expert" onModeChange={() => undefined} />);
    expect(html).toContain('aria-checked="true"');
  });

  test("detail_pages_keep_their_own_test_id", () => {
    const html = renderToString(
      <ExpertSwitch mode="simple" onModeChange={() => undefined} testId="detail-expert-switch" />,
    );
    expect(html).toContain('data-testid="detail-expert-switch"');
  });

  test("shows a track plus a state word in both states", () => {
    const simple = renderToString(<ExpertSwitch mode="simple" onModeChange={() => undefined} />);
    expect(simple).toContain("switch-track");
    expect(simple).toContain("switch-knob");
    expect(simple).toContain(">Off<");
    const expert = renderToString(<ExpertSwitch mode="expert" onModeChange={() => undefined} />);
    expect(expert).toContain("switch-track");
    expect(expert).toContain(">On<");
  });
});
