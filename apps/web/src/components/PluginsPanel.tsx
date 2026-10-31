import type { JSX } from "react";
import { applyPersonalizedOrder } from "../lib/matcher.ts";
import { SchemaValue } from "./SchemaValue.tsx";
import { Explain } from "./Explain.tsx";

// Generic plugins panel (S-046): renders the registry plugin list beside
// the analysis pluginResults with no per-plugin UI code. Every plugin
// string renders as React text only, so hostile content stays inert under
// the strict CSP: no HTML sinks anywhere in this view.
export type PluginFrontmatterView = {
  readonly tags: readonly string[];
  readonly audience: readonly string[];
  readonly severity: { readonly min: string; readonly max: string };
};

export type PluginListEntry = {
  readonly id: string;
  readonly version: string;
  readonly displayName: string;
  readonly description: string;
  readonly outputSchema?: unknown;
  readonly frontmatter?: PluginFrontmatterView;
};

export type PluginFindingView = {
  readonly id: string;
  readonly title: string;
  readonly payload?: unknown;
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

function payloadSchemaOf(outputSchema: unknown): unknown {
  if (typeof outputSchema !== "object" || outputSchema === null || Array.isArray(outputSchema)) {
    return undefined;
  }
  const record = outputSchema as Record<string, unknown>;
  const items = record["items"];
  if (typeof items === "object" && items !== null && !Array.isArray(items)) {
    const properties = (items as Record<string, unknown>)["properties"];
    if (typeof properties === "object" && properties !== null && !Array.isArray(properties)) {
      const payload = (properties as Record<string, unknown>)["payload"];
      if (payload !== undefined) {
        return payload;
      }
    }
  }
  return outputSchema;
}

function ResultBlock({
  heading,
  findings,
  outputSchema,
}: {
  readonly heading: string;
  readonly findings: readonly PluginFindingView[];
  readonly outputSchema?: unknown;
}): JSX.Element {
  if (findings.length === 0) {
    return (
      <p className="muted" style={{ margin: "4px 0 0", fontSize: 14 }}>
        {heading}: no findings.
      </p>
    );
  }
  // One Explain trigger per finding group (S-120): the PC rows below
  // carry no triggers of their own, so the panel stays navigable even
  // with hundreds of evidence pointers.
  return (
    <ul className="mono" style={{ listStyle: "none", padding: 0, fontSize: 13 }}>
      {findings.map((finding) => (
        <li key={finding.id}>
          {finding.title}{" "}
          <Explain explainKey="evidence:payload" label={`Finding ${finding.id}`} />
          {finding.payload === undefined ? null : (
            <div style={{ margin: "4px 0 4px 12px" }}>
              <SchemaValue value={finding.payload} schema={payloadSchemaOf(outputSchema)} />
            </div>
          )}
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
  order,
  matchedTags,
  personalized,
  source,
  aiModelId,
  onShowStandardOrder,
}: {
  readonly plugins: readonly PluginListEntry[] | null;
  readonly results: readonly PluginResultView[];
  readonly order?: readonly string[] | undefined;
  readonly matchedTags?: ReadonlyMap<string, readonly string[]> | undefined;
  readonly personalized?: boolean | undefined;
  readonly source?: "ai" | "deterministic" | undefined;
  readonly aiModelId?: string | undefined;
  readonly onShowStandardOrder?: (() => void) | undefined;
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
            <ResultBlock heading={result.pluginId} findings={result.findings} outputSchema={undefined} />
          </article>
        ))}
      </section>
    );
  }
  // Deterministic priority order (S-067, K-035, P-25) under the severity
  // floor (P-26): floored cards (frontmatter severity max `high`) clamp
  // ahead, then matched cards, then the rest in standard order. No card
  // is hidden, removed or reworded; only order and emphasis change.
  const active = personalized === true && order !== undefined && order.length > 0;
  const flooredIds = plugins
    .filter((plugin) => plugin.frontmatter?.severity.max === "high")
    .map((plugin) => plugin.id);
  const entries = active
    ? applyPersonalizedOrder(plugins, order, flooredIds)
    : plugins;
  // Findings expand; plugins with no findings collapse to one line
  // (S-120), so a quiet detector costs one sentence, not a card.
  const withFindings = entries.filter((plugin) => findingsFor(plugin.id, results).length > 0);
  const withoutFindings = entries.filter((plugin) => findingsFor(plugin.id, results).length === 0);
  // AI order (P0-5, N-14): name up to three top-ranked detectors even
  // when they found nothing, so the ranking has a visible effect. The
  // detectors ran deterministically; the AI only ranked them.
  const displayNameOf = (pluginId: string): string =>
    plugins?.find((plugin) => plugin.id === pluginId)?.displayName ?? pluginId;
  const checkedFirst = active
    ? (order ?? []).filter((pluginId) => findingsFor(pluginId, results).length === 0).slice(0, 3)
    : [];
  const checkedFirstNames = checkedFirst.map((pluginId) => displayNameOf(pluginId));
  const remainingWithout = withoutFindings.filter((plugin) => !checkedFirst.includes(plugin.id));
  return (
    <section aria-label="Plugins">
      <h2>Plugins</h2>
      {active ? (
        <div className="plugins-personalized">
          <p className="quiet plugins-notice" data-testid="personalized-notice">
            {source === "ai"
              ? aiModelId === undefined || aiModelId.length === 0
                ? "Ordered by AI from your priorities."
                : `Ordered by AI (${aiModelId}) from your priorities.`
              : "Ordered by what matters to you."}
          </p>
          {onShowStandardOrder === undefined ? null : (
            <button type="button" className="button-ghost" data-testid="standard-order" onClick={onShowStandardOrder}>
              Show standard order
            </button>
          )}
        </div>
      ) : null}
      {withFindings.map((plugin) => {
        const tags = active ? (matchedTags?.get(plugin.id) ?? []) : [];
        return (
          <article key={plugin.id}>
            <h3 style={{ fontSize: 15 }}>
              <span>{plugin.displayName}</span> <Explain explainKey={`plugin:${plugin.id}`} label={plugin.displayName} />
            </h3>
            <p className="quiet" style={{ margin: "4px 0 0", fontSize: 13 }}>
              {plugin.id} · v{plugin.version}
            </p>
            <p className="muted" style={{ margin: "4px 0 0", fontSize: 14 }}>
              {plugin.description}
            </p>
            {tags.length === 0 ? null : (
              <p className="quiet" data-testid={`matched-${plugin.id}`} style={{ margin: "4px 0 0", fontSize: 13 }}>
                Matched: {tags.join(", ")}
              </p>
            )}
            <ResultBlock
              heading={plugin.displayName}
              findings={findingsFor(plugin.id, results)}
              outputSchema={plugin.outputSchema}
            />
          </article>
        );
      })}
      {checkedFirstNames.length === 0 ? null : (
        <p className="quiet" data-testid="ai-checked-first" style={{ margin: "8px 0 0", fontSize: 13 }}>
          {`Your top-ranked detectors found nothing: ${checkedFirstNames.join(", ")}.`}
        </p>
      )}
      {remainingWithout.length === 0 ? null : (
        <p className="quiet" style={{ margin: "8px 0 0", fontSize: 13 }}>
          {remainingWithout.length === 1 ? "1 detector found nothing" : `${remainingWithout.length} detectors found nothing`}
          : {remainingWithout.map((plugin) => plugin.displayName).join(", ")}
        </p>
      )}
    </section>
  );
}
