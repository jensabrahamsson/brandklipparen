import type { JSX } from "react";

// Generic plugins panel (S-046): renders the registry plugin list beside
// the analysis pluginResults with no per-plugin UI code. Every plugin
// string renders as React text only, so hostile content stays inert under
// the strict CSP: no HTML sinks anywhere in this view.
export type PluginListEntry = {
  readonly id: string;
  readonly version: string;
  readonly displayName: string;
  readonly description: string;
};

export type PluginFindingView = {
  readonly id: string;
  readonly title: string;
  readonly evidence: readonly { readonly selector: string; readonly offset: number | null }[];
};

export type PluginResultView = {
  readonly pluginId: string;
  readonly pluginVersion: string;
  readonly outcome: string;
  readonly findings: readonly PluginFindingView[];
};

function findingsFor(pluginId: string, results: readonly PluginResultView[]): readonly PluginFindingView[] {
  const entry = results.find((result) => result.pluginId === pluginId);
  return entry?.findings ?? [];
}

function ResultBlock({
  heading,
  findings,
}: {
  readonly heading: string;
  readonly findings: readonly PluginFindingView[];
}): JSX.Element {
  if (findings.length === 0) {
    return (
      <p className="muted" style={{ margin: "4px 0 0", fontSize: 14 }}>
        {heading}: no findings.
      </p>
    );
  }
  return (
    <ul className="mono" style={{ listStyle: "none", padding: 0, fontSize: 13 }}>
      {findings.map((finding) => (
        <li key={finding.id}>
          {finding.title}
          <ul style={{ listStyle: "none", padding: "0 0 0 12px" }}>
            {finding.evidence.map((entry, index) => (
              <li key={`${entry.selector}-${index}`} className="quiet">
                {entry.selector}
                {entry.offset === null ? "" : ` · PC 0x${entry.offset.toString(16)}`}
              </li>
            ))}
          </ul>
        </li>
      ))}
    </ul>
  );
}

export function PluginsPanel({
  plugins,
  results,
}: {
  readonly plugins: readonly PluginListEntry[] | null;
  readonly results: readonly PluginResultView[];
}): JSX.Element {
  if (results.length === 0) {
    return <p className="muted">No plugin results.</p>;
  }
  if (plugins === null) {
    return (
      <section aria-label="Plugins">
        <h2>Plugins</h2>
        {results.map((result) => (
          <article key={result.pluginId}>
            <h3 className="mono" style={{ fontSize: 14 }}>
              {result.pluginId}
            </h3>
            <ResultBlock heading={result.pluginId} findings={result.findings} />
          </article>
        ))}
      </section>
    );
  }
  return (
    <section aria-label="Plugins">
      <h2>Plugins</h2>
      {plugins.map((plugin) => (
        <article key={plugin.id}>
          <h3 style={{ fontSize: 15 }}>{plugin.displayName}</h3>
          <p className="quiet" style={{ margin: "4px 0 0", fontSize: 13 }}>
            {plugin.id} · v{plugin.version}
          </p>
          <p className="muted" style={{ margin: "4px 0 0", fontSize: 14 }}>
            {plugin.description}
          </p>
          <ResultBlock heading={plugin.displayName} findings={findingsFor(plugin.id, results)} />
        </article>
      ))}
    </section>
  );
}
