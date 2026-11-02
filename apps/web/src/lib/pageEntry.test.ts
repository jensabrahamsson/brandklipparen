// Page entry (UI-7): which route changes count as a new page, and which
// entries move focus to the page heading. Behavior only; the DOM half
// (scroll and focus) is covered by the e2e spec.
import { describe, expect, test } from "vitest";
import { entryFocusesHeading, pageIdentity } from "./pageEntry.ts";
import type { Route } from "./route.ts";

const TOKEN = "0x5ab1e0000000000000000000000000000000a001";
const OTHER = "0x5ab1e0000000000000000000000000000000b002";

const main: Route = { name: "token", address: TOKEN, view: { kind: "main" } };
const board: Route = { name: "token", address: TOKEN, view: { kind: "plugins" } };
const detail: Route = { name: "token", address: TOKEN, view: { kind: "plugin", slug: "pause" } };
const deepLink: Route = {
  name: "token",
  address: TOKEN,
  view: { kind: "plugin", slug: "decompiler", fn: "0x44337ea1", view: "source", pc: 200 },
};

describe("page entry", () => {
  test("a token's plugin views share the token's page identity", () => {
    expect(pageIdentity(board)).toBe(pageIdentity(main));
    expect(pageIdentity(detail)).toBe(pageIdentity(main));
    expect(pageIdentity(deepLink)).toBe(pageIdentity(main));
  });

  test("another token or another top-level page is a new page", () => {
    expect(pageIdentity({ name: "token", address: OTHER, view: { kind: "main" } })).not.toBe(pageIdentity(main));
    expect(pageIdentity({ name: "start" })).toBe("start");
    expect(pageIdentity({ name: "about" })).toBe("about");
    expect(pageIdentity({ name: "settings" })).toBe("settings");
  });

  test("entering the start, about, settings or a token's main view focuses the heading", () => {
    expect(entryFocusesHeading({ name: "start" })).toBe(true);
    expect(entryFocusesHeading({ name: "about" })).toBe(true);
    expect(entryFocusesHeading({ name: "settings" })).toBe(true);
    expect(entryFocusesHeading(main)).toBe(true);
  });

  test("plugin views and deep-linked rows keep their own focus", () => {
    expect(entryFocusesHeading(board)).toBe(false);
    expect(entryFocusesHeading(detail)).toBe(false);
    expect(entryFocusesHeading(deepLink)).toBe(false);
  });
});
