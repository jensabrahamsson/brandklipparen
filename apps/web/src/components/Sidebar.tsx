import type { JSX } from "react";
import type { AnalyzeSuccess } from "../types.ts";

// Sidebar with contract facts and example API calls (K-021). Everything
// renders as text; addresses and hashes use the mono style and copy on
// click through the clipboard control beside them.
function Copyable({ label, value }: { readonly label: string; readonly value: string }): JSX.Element {
  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(value);
    } catch {
      // Clipboard is a convenience only; the text stays selectable.
    }
  };
  return (
    <div style={{ marginBottom: 12 }}>
      <div className="quiet">{label}</div>
      <div className="mono numeric" style={{ fontSize: 13, overflowWrap: "anywhere" }}>
        {value}{" "}
        <button type="button" className="button-ghost" onClick={() => void copy()} aria-label={`Copy ${label}`}>
          Copy
        </button>
      </div>
    </div>
  );
}

export function Sidebar({ result }: { readonly result: AnalyzeSuccess }): JSX.Element {
  const apiExample = `curl -H "x-api-key: $KEY" \\\n  "${`/v1/analyze?address=${result.target}`}";`;
  const mcpExample = `request_assessment { address: "${result.target}" }`;
  return (
    <aside aria-label="Contract facts">
      <section className="card" style={{ marginBottom: 20 }}>
        <h2 style={{ margin: "0 0 12px", fontSize: 17 }}>Contract facts</h2>
        <Copyable label="Address" value={result.target} />
        <Copyable label="Proxy" value={proxyLabel(result)} />
        <Copyable label="Code hash" value={result.codeHash} />
        <Copyable label="Model version" value={result.modelVersion} />
        <div className="quiet numeric">Analyzed block {result.block}</div>
      </section>
      <section className="card">
        <h2 style={{ margin: "0 0 12px", fontSize: 17 }}>Use this result in your bot</h2>
        <div className="quiet">REST API</div>
        <pre className="code">{apiExample}</pre>
        <div className="quiet">MCP tool</div>
        <pre className="code">{mcpExample}</pre>
      </section>
    </aside>
  );
}

function proxyLabel(result: AnalyzeSuccess): string {
  if (result.proxy.kind === "none") {
    return "No proxy (direct implementation)";
  }
  const implementation = result.proxy.implementation ?? "unknown implementation";
  return `${result.proxy.kind} → ${implementation}`;
}
