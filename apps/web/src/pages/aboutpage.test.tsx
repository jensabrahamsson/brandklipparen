// UI-4 About page: behavior only — rendered text, roles, accessible
// names and heading order. No fetch, no network.
import { describe, expect, test } from "vitest";
import { renderToString } from "react-dom/server";
import { AboutPage } from "./AboutPage.tsx";
import { parseHash } from "../lib/route.ts";

function html(): string {
  return renderToString(<AboutPage />);
}

describe("about page copy (UI-4)", () => {
  test("about_heading_sub_and_sections_render_in_order", () => {
    const page = html();
    expect(page).toContain("Brandklipparen");
    expect(page).toContain("contract risk scanner");
    expect(page).toContain("scan before you swap");
    const order = [
      "What it does",
      "How the score works",
      "Where AI fits",
      "For developers",
      "The horse",
      "Who made it",
    ];
    let cursor = -1;
    for (const heading of order) {
      const next = page.indexOf(heading, cursor + 1);
      expect(next).toBeGreaterThan(cursor);
      cursor = next;
    }
  });

  test("about_states_score_rules_and_advice_disclaimer", () => {
    const page = html();
    expect(page).toContain("Low never means safe");
    expect(page).toContain("never changes the score or the evidence");
    expect(page).toContain("Not financial advice");
    expect(page).toContain("never flinched at fire");
    expect(page).toContain("Jens Abrahamsson");
    expect(page).toContain("Ehrenstrahl");
  });

  test("about_links_repo_and_horse_mark_present", () => {
    const page = html();
    expect(page).toContain("https://github.com/jensabrahamsson/brandklipparen");
    expect(page).toContain("https://github.com/jensabrahamsson/jstack");
    expect(page).toContain('alt="Brandklipparen horse mark"');
  });

  test("horse_and_maker_sections_tell_their_stories", () => {
    const page = html();
    expect(page).toContain("Charles XI of Sweden");
    expect(page).toContain("Charles XII");
    expect(page).toContain("David Kl\u00f6cker Ehrenstrahl");
    expect(page).toContain("poor fodder, hard cold, and long marches");
    expect(page).toContain("smoke, flames,");
    expect(page).toContain("dangerous");
    expect(page).toContain("reborn passion for building software");
    expect(page).toContain("delegation approach in");
    expect(page).toContain(">jstack</a>");
  });
});

describe("about route (UI-4)", () => {
  test("about_hash_parses_to_about_route", () => {
    expect(parseHash("#/about")).toEqual({ name: "about" });
  });
});
