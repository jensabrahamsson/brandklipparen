// Motion switch behavior (UI v2 §5.6, W-10): the footer switch keeps a
// real 44 px box, announces its state through aria-checked, and pins or
// clears `data-motion` on the document so the whole page goes static.
import { afterEach, describe, expect, test, vi } from "vitest";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { MotionSwitch } from "./MotionSwitch.tsx";

describe("motion switch", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test("renders the accessible name and the on state", () => {
    const dataset: Record<string, string | undefined> = {};
    const store = new Map<string, string>([["brandklipparen-motion", "on"]]);
    vi.stubGlobal("document", { documentElement: { dataset } });
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => {
        store.set(key, value);
      },
    } as Storage);
    const html = renderToString(createElement(MotionSwitch));
    expect(html).toContain('aria-label="Motion"');
    expect(html).toContain('aria-checked="true"');
  });

  test("renders the off state from storage", () => {
    const dataset: Record<string, string | undefined> = {};
    const store = new Map<string, string>([["brandklipparen-motion", "off"]]);
    vi.stubGlobal("document", { documentElement: { dataset } });
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => {
        store.set(key, value);
      },
    } as Storage);
    const html = renderToString(createElement(MotionSwitch));
    expect(html).toContain('aria-checked="false"');
  });
});
