// Start page first 30 seconds (U-11, D-14): two example links under
// the search, fresh sub-copy, no kicker, no Chain pill, Settings folded
// into an "API key" footer disclosure. Behavior based: rendered text,
// links and hrefs only; fetch stays mocked so no test reaches the
// network.
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { renderToString } from "react-dom/server";
import { StartPage, TRY_EXAMPLES } from "./StartPage.tsx";
import { isValidAddress } from "../lib/validate.ts";

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockRejectedValue(new Error("no network in component tests")),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function html(): string {
  return renderToString(<StartPage apiKey="" onApiKeyChange={() => {}} onAnalyze={() => {}} />);
}

describe("start page first 30 seconds (D-14)", () => {
  test("try_examples_name_two_tokens_with_valid_addresses", () => {
    expect(TRY_EXAMPLES).toHaveLength(2);
    expect(TRY_EXAMPLES.map((example) => example.name)).toContain("USDT");
    expect(TRY_EXAMPLES.map((example) => example.name)).toContain("PEPE");
    expect(TRY_EXAMPLES.map((example) => example.address)).toContain("0xdAC17F958D2ee523a2206206994597C13D831ec7");
    expect(TRY_EXAMPLES.map((example) => example.address)).toContain("0x6982508145454ce325ddbe47a25d4ec3d2311933");
    for (const example of TRY_EXAMPLES) {
      expect(isValidAddress(example.address)).toBe(true);
    }
  });

  test("try_chips_render_as_links_under_the_search", () => {
    const page = html();
    expect(page).toContain("Try:");
    for (const example of TRY_EXAMPLES) {
      expect(page).toContain(`href="#/token/${example.address}"`);
      expect(page).toContain(`>${example.name}</a>`);
    }
    expect(page).toContain("See what its owner can do to you, in plain English.");
  });

  test("stale_copy_and_chain_pill_are_gone", () => {
    const page = html();
    for (const stale of ["bytecode alone", "BK/1", "ERC-20 contract reader"]) {
      expect(page).not.toContain(stale);
    }
    expect(page).not.toContain("Chain");
    expect(page).not.toContain("Settings");
    expect(page).toContain("API key");
    expect(page).toContain("Deterministic score");
  });
});
