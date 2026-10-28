// Expert detail section (S-061, K-034, P-20). Shows what the frozen
// response already carries and Simple hides: the analyzed-bytecode
// identity (address, block, code hash), the full selector table with PC
// offsets, and raw plugin payloads as canonical JSON. Everything renders
// as inert text under the strict CSP; the section triggers no new
// analysis and changes no score or evidence.
import type { JSX } from "react";
import type { AnalyzeResult } from "../types.ts";
import { canonicalJson } from "../lib/schemaValue.ts";
import { toPluginResultViews } from "../lib/plugins.ts";

export function ExpertDetail({
  result,
}: {
  readonly result: Extract<AnalyzeResult, { kind: "assessed" }>;
}): JSX.Element {
  const pluginViews = result.pluginResults === undefined ? [] : toPluginResultViews(result.pluginResults);
  const selectorRows = result.signals.flatMap((signal) =>
    signal.evidence.map((entry) => ({ signal: signal.id, selector: entry.selector, offset: entry.offset })),
  );
  return (
    <section className="card" aria-label="Expert detail" data-testid="expert-detail" style={{ marginBottom: 20 }}>
      <h2 style={{ margin: "0 0 4px", fontSize: 20 }}>Expert detail</h2>
      <p className="quiet" style={{ margin: "0 0 12px", fontSize: 14 }}>
        Raw response data as inert text. Scores and evidence are unchanged.
      </p>
      <h3 style={{ fontSize: 15 }}>Bytecode under analysis</h3>
      <dl className="mono" style={{ fontSize: 13 }}>
        <div>
          <dt style={{ display: "inline" }}>target </dt>
          <dd style={{ display: "inline", margin: 0 }}>{result.target}</dd>
        </div>
        <div>
          <dt style={{ display: "inline" }}>block </dt>
          <dd style={{ display: "inline", margin: 0 }} className="numeric">
            {result.block}
          </dd>
        </div>
        <div>
          <dt style={{ display: "inline" }}>codeHash </dt>
          <dd style={{ display: "inline", margin: 0 }}>{result.codeHash}</dd>
        </div>
        <div>
          <dt style={{ display: "inline" }}>model </dt>
          <dd style={{ display: "inline", margin: 0 }}>
            {result.modelVersion} · {result.artifactChecksum}
          </dd>
        </div>
      </dl>
      <p className="quiet" style={{ fontSize: 13 }}>
        Bytecode text is not part of the v1 response; the code hash identifies the analyzed bytes.
      </p>
      <h3 style={{ fontSize: 15 }}>Selectors with PC offsets</h3>
      {selectorRows.length === 0 ? (
        <p className="muted" style={{ fontSize: 14 }}>
          No selectors in this analysis.
        </p>
      ) : (
        <ul className="mono" data-testid="expert-selectors" style={{ listStyle: "none", padding: 0, fontSize: 13 }}>
          {selectorRows.map((row, index) => (
            <li key={`${row.signal}-${row.selector}-${index}`}>
              {row.signal} · {row.selector}
              {row.offset === null ? "" : ` · PC 0x${row.offset.toString(16)}`}
            </li>
          ))}
        </ul>
      )}
      <h3 style={{ fontSize: 15 }}>Raw plugin payloads</h3>
      {pluginViews.length === 0 ? (
        <p className="muted" style={{ fontSize: 14 }}>
          No plugin results in this analysis.
        </p>
      ) : (
        <div data-testid="raw-plugin-payloads">
          {pluginViews.map((view) => (
            <div key={view.pluginId}>
              <h4 className="mono" style={{ fontSize: 13 }}>
                {view.pluginId}
              </h4>
              {view.findings.length === 0 ? (
                <p className="muted" style={{ fontSize: 14 }}>
                  No findings.
                </p>
              ) : (
                <ul className="mono" style={{ listStyle: "none", padding: 0, fontSize: 13 }}>
                  {view.findings.map((finding) => (
                    <li key={finding.id}>
                      {finding.id}:{" "}
                      {finding.payload === undefined ? "no payload" : canonicalJson(finding.payload)}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
