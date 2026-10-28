// S-059 schema-driven plugin panel (K-034, P-18). Every plugin output
// shape in the documented `outputSchema` subset renders through the fixed
// component library with no per-plugin UI code; an out-of-subset shape
// falls back to canonical JSON as inert text. Written first (red) per
// A-21: the SchemaValue library does not exist yet. No network; React
// server rendering only.
import { describe, expect, test } from "vitest";
import { renderToString } from "react-dom/server";
import { SchemaValue } from "./SchemaValue.tsx";
import { canonicalJson } from "../lib/schemaValue.ts";

const TEXT_SCHEMA = { type: "string" } as const;
const NUMBER_SCHEMA = { type: "number" } as const;
const BOOLEAN_SCHEMA = { type: "boolean" } as const;
const ENUM_SCHEMA = { type: "string", enum: ["a", "b"] } as const;
const LIST_SCHEMA = { type: "array", items: { type: "string" } } as const;
const OBJECT_SCHEMA = {
  type: "object",
  properties: {
    selector: { type: "string" },
    count: { type: "number" },
  },
  additionalProperties: false,
} as const;
const EVIDENCE_SCHEMA = {
  type: "array",
  items: {
    type: "object",
    properties: {
      selector: { type: "string" },
      offset: { type: ["integer", "null"] },
    },
  },
} as const;

describe("k034_every_output_schema_shape_renders_via_fixed_library", () => {
  test("text renders as text", () => {
    const html = renderToString(<SchemaValue value="hello world" schema={TEXT_SCHEMA} />);
    expect(html).toContain("hello world");
  });

  test("number renders as a metric with tabular figures", () => {
    const html = renderToString(<SchemaValue value={42} schema={NUMBER_SCHEMA} />);
    expect(html).toContain("42");
    expect(html).toContain("metric");
  });

  test("boolean renders as a badge", () => {
    const html = renderToString(<SchemaValue value={true} schema={BOOLEAN_SCHEMA} />);
    expect(html).toContain("badge");
    expect(html).toContain("yes");
  });

  test("enum renders as a badge with the value", () => {
    const html = renderToString(<SchemaValue value="a" schema={ENUM_SCHEMA} />);
    expect(html).toContain("badge");
    expect(html).toContain(">a<");
  });

  test("list renders every entry", () => {
    const html = renderToString(<SchemaValue value={["one", "two"]} schema={LIST_SCHEMA} />);
    expect(html).toContain("one");
    expect(html).toContain("two");
    expect(html).toContain("<ul");
  });

  test("nested object renders key-value rows", () => {
    const html = renderToString(
      <SchemaValue value={{ selector: "0x12345678", count: 3 }} schema={OBJECT_SCHEMA} />,
    );
    expect(html).toContain("selector");
    expect(html).toContain("0x12345678");
    expect(html).toContain("count");
  });

  test("evidence renders selector links with PC offsets", () => {
    const html = renderToString(
      <SchemaValue
        value={[{ selector: "0x12345678", offset: 26 }]}
        schema={EVIDENCE_SCHEMA}
      />,
    );
    expect(html).toContain("0x12345678");
    expect(html).toContain("PC 0x1a");
  });
});

describe("k034_unknown_schema_shape_falls_back_to_canonical_json_text", () => {
  test("an out-of-subset shape renders inert canonical JSON", () => {
    const value = { b: 1, a: [true, "x"] };
    const html = renderToString(
      <SchemaValue value={value} schema={{ type: "weird-custom-shape" }} />,
    );
    // React server rendering escapes the quotes; the text stays inert.
    expect(html).toContain(canonicalJson(value).replaceAll('"', "&quot;"));
    expect(html).toContain("canonical-json");
    expect(html).not.toContain('type="weird-custom-shape"');
  });

  test("a value outside its schema renders the canonical JSON fallback", () => {
    const value = { nested: { deep: [1, 2] } };
    const html = renderToString(<SchemaValue value={value} schema={TEXT_SCHEMA} />);
    expect(html).toContain("canonical-json");
  });
});

describe("k515_plugin_strings_render_as_inert_text", () => {
  test("hostile payload strings never execute", () => {
    const html = renderToString(
      <SchemaValue value="<script>alert(1)</script>" schema={TEXT_SCHEMA} />,
    );
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });

  test("hostile keys and enum values render escaped", () => {
    const html = renderToString(
      <SchemaValue
        value={{ "<img src=x onerror=alert(2)>": "<b>bold</b>" }}
        schema={{ type: "object", properties: {}, additionalProperties: true }}
      />,
    );
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<b>");
  });
});

describe("example-shaped plugin fixture renders with no UI code changed", () => {
  test("fee-capability payload shape renders selector and name", () => {
    const schema = {
      type: "object",
      required: ["selector", "name"],
      properties: {
        selector: { type: "string" },
        name: { type: "string" },
      },
      additionalProperties: false,
    } as const;
    const html = renderToString(
      <SchemaValue value={{ selector: "0xa9059cbb", name: "transfer" }} schema={schema} />,
    );
    expect(html).toContain("0xa9059cbb");
    expect(html).toContain("transfer");
  });
});
