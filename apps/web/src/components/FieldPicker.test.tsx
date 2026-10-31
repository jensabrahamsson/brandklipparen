// Field picker labels (P2-17): the collapsed AI buttons and the picker
// reuse these labels, so the visitor never sees a raw section id.
import { describe, expect, test } from "vitest";
import { renderToString } from "react-dom/server";
import { FieldPicker, PICKABLE_SECTIONS } from "./FieldPicker.tsx";

describe("field picker labels (P2-17)", () => {
  test("every pickable section carries a human label", () => {
    for (const section of PICKABLE_SECTIONS) {
      expect(section.label.length).toBeGreaterThan(0);
      expect(section.label).not.toBe(section.id);
    }
  });

  test("picker renders labels instead of raw ids", () => {
    const html = renderToString(<FieldPicker visible={new Set(["score"])} onToggle={() => {}} />);
    const text = html.replace(/<!--.*?-->/g, "").replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/\s+/g, " ");
    expect(text).toContain("Choose sections");
    expect(text).toContain("Show Plugin findings");
    expect(text).toContain("Show Can't-tell");
    expect(text).not.toContain("plugin-findings");
    expect(text).not.toContain("cant-tell");
  });
});
