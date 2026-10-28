// Schema-driven value helpers (S-059, K-034, P-18). Pure: no network, no
// storage, no randomness. The fixed component library maps the documented
// `outputSchema` keyword subset to presentational primitives only; plugin
// markup, styles, scripts, URLs and component names are unrepresentable.
// Values outside the subset — or outside their schema — fall back to
// canonical JSON rendered as inert text.

// Canonical JSON for the fallback path: object keys sort lexicographically,
// arrays keep order, numbers write in shortest round-trip form. Undefined,
// functions and symbols have no canonical form and become null, so the
// fallback never throws on plugin data.
export function canonicalJson(value: unknown): string {
  if (value === null || value === undefined) {
    return "null";
  }
  if (typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? JSON.stringify(value) : "null";
  }
  if (typeof value === "boolean") {
    return value ? "true" : "false";
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  }
  if (typeof value === "object") {
    const keys = Object.keys(value).sort();
    const body = keys
      .map((key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`)
      .join(",");
    return `{${body}}`;
  }
  return "null";
}

export type SchemaShape = "text" | "number" | "boolean" | "enum" | "list" | "object" | "unknown";

function schemaTypeOf(schema: unknown): string | readonly string[] | undefined {
  if (typeof schema !== "object" || schema === null || Array.isArray(schema)) {
    return undefined;
  }
  const raw = (schema as Record<string, unknown>)["type"];
  if (typeof raw === "string") {
    return raw;
  }
  if (Array.isArray(raw) && raw.every((entry) => typeof entry === "string")) {
    return raw as readonly string[];
  }
  return undefined;
}

function schemaEnumOf(schema: unknown): readonly unknown[] | undefined {
  if (typeof schema !== "object" || schema === null || Array.isArray(schema)) {
    return undefined;
  }
  const raw = (schema as Record<string, unknown>)["enum"];
  if (Array.isArray(raw)) {
    return raw;
  }
  return undefined;
}

function schemaConstOf(schema: unknown): { readonly present: boolean; readonly value: unknown } {
  if (typeof schema !== "object" || schema === null || Array.isArray(schema)) {
    return { present: false, value: undefined };
  }
  const record = schema as Record<string, unknown>;
  if (!Object.hasOwn(record, "const")) {
    return { present: false, value: undefined };
  }
  return { present: true, value: record["const"] };
}

// Component choice is a pure function of schema shape and value type: one
// branch per library component, so a new plugin shape needs no UI code.
export function schemaShapeOf(schema: unknown, value: unknown): SchemaShape {
  const declared = schemaTypeOf(schema);
  const declaredList = declared === undefined ? [] : Array.isArray(declared) ? declared : [declared];
  const enumValues = schemaEnumOf(schema);
  const constant = schemaConstOf(schema);
  if (enumValues !== undefined || constant.present) {
    return "enum";
  }
  if (declaredList.length === 0) {
    // Schemaless values still render through the value-driven fallback:
    // objects and arrays keep structure, scalars keep text.
    if (typeof value === "number" || typeof value === "bigint") {
      return "number";
    }
    if (typeof value === "boolean") {
      return "boolean";
    }
    if (typeof value === "string") {
      return "text";
    }
    if (Array.isArray(value)) {
      return "list";
    }
    if (typeof value === "object" && value !== null) {
      return "object";
    }
    return "unknown";
  }
  if (declaredList.includes("boolean") && typeof value === "boolean") {
    return "boolean";
  }
  if (
    (declaredList.includes("number") || declaredList.includes("integer")) &&
    (typeof value === "number" || typeof value === "bigint")
  ) {
    return "number";
  }
  if (declaredList.includes("string") && typeof value === "string") {
    return "text";
  }
  if (declaredList.includes("array") && Array.isArray(value)) {
    return "list";
  }
  if (declaredList.includes("object") && typeof value === "object" && value !== null && !Array.isArray(value)) {
    return "object";
  }
  return "unknown";
}

// Evidence-shaped values render as evidence links wherever they appear:
// a non-empty array whose entries all carry a string selector.
export function isEvidenceValue(value: unknown): value is readonly { readonly selector: unknown; readonly offset: unknown }[] {
  if (!Array.isArray(value) || value.length === 0) {
    return false;
  }
  return value.every(
    (entry) =>
      typeof entry === "object" &&
      entry !== null &&
      !Array.isArray(entry) &&
      typeof (entry as Record<string, unknown>)["selector"] === "string",
  );
}

export function evidenceOffsetText(offset: unknown): string {
  if (typeof offset === "number" && Number.isInteger(offset) && offset >= 0) {
    return ` · PC 0x${offset.toString(16)}`;
  }
  return "";
}
