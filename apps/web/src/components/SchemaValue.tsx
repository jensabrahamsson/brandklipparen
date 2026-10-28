// Fixed component library for plugin output (S-059, K-034, P-18).
// Presentational primitives only: text, metric with tabular figures
// (K-103), boolean badge, enum badge, list, key-value object, evidence
// list, and the canonical-JSON fallback. Every plugin string renders as
// React text only, so hostile content stays inert under the strict CSP:
// no HTML sink exists in this view.
import type { JSX } from "react";
import { canonicalJson, evidenceOffsetText, isEvidenceValue, schemaShapeOf } from "../lib/schemaValue.ts";

function subschemaOf(schema: unknown, key: string): unknown {
  if (typeof schema !== "object" || schema === null || Array.isArray(schema)) {
    return undefined;
  }
  const properties = (schema as Record<string, unknown>)["properties"];
  if (typeof properties !== "object" || properties === null || Array.isArray(properties)) {
    return undefined;
  }
  return (properties as Record<string, unknown>)[key];
}

function itemsSchemaOf(schema: unknown): unknown {
  if (typeof schema !== "object" || schema === null || Array.isArray(schema)) {
    return undefined;
  }
  return (schema as Record<string, unknown>)["items"];
}

export function SchemaValue({
  value,
  schema,
}: {
  readonly value: unknown;
  readonly schema: unknown;
}): JSX.Element {
  if (isEvidenceValue(value)) {
    return (
      <ul className="mono" data-component="evidence" style={{ listStyle: "none", padding: 0, fontSize: 13 }}>
        {value.map((entry, index) => (
          <li key={`${String(entry.selector)}-${index}`} className="quiet">
            {String(entry.selector)}
            {evidenceOffsetText(entry.offset)}
          </li>
        ))}
      </ul>
    );
  }
  const shape = schemaShapeOf(schema, value);
  switch (shape) {
    case "text":
      return <span data-component="text">{String(value)}</span>;
    case "number":
      return (
        <span className="numeric" data-component="metric">
          {String(value)}
        </span>
      );
    case "boolean":
      return (
        <span className="badge" data-component="badge">
          {value === true ? "yes" : "no"}
        </span>
      );
    case "enum":
      return (
        <span className="badge" data-component="badge">
          {typeof value === "string" || typeof value === "number" ? value : canonicalJson(value)}
        </span>
      );
    case "list":
      return (
        <ul data-component="list" style={{ listStyle: "none", padding: 0 }}>
          {(value as readonly unknown[]).map((entry, index) => (
            <li key={index}>
              <SchemaValue value={entry} schema={itemsSchemaOf(schema)} />
            </li>
          ))}
        </ul>
      );
    case "object": {
      const entries = Object.keys(value as Record<string, unknown>).sort();
      return (
        <dl data-component="object" style={{ margin: 0, fontSize: 13 }}>
          {entries.map((key) => (
            <div key={key}>
              <dt className="quiet mono" style={{ display: "inline" }}>
                {key}
              </dt>{" "}
              <dd className="mono" style={{ display: "inline", margin: 0 }}>
                <SchemaValue value={(value as Record<string, unknown>)[key]} schema={subschemaOf(schema, key)} />
              </dd>
            </div>
          ))}
        </dl>
      );
    }
    case "unknown":
    default:
      return (
        <span className="mono" data-component="canonical-json">
          {canonicalJson(value)}
        </span>
      );
  }
}
